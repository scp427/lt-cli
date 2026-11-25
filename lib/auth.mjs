import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { NeteaseClient } from './netease.mjs'
import { qrcode } from '../vendor/qrcode.mjs'

const HOME_DIR = path.join(os.homedir(), '.lt-cli')
export const COOKIE_FILE = path.join(HOME_DIR, 'account.json')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function loadCookie() {
  try {
    return String(JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')).cookie ?? '')
  } catch {
    return ''
  }
}

export function saveCookie(cookie, source = 'qr') {
  fs.mkdirSync(HOME_DIR, { recursive: true })
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({
    cookie, source, savedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 })
}

export function tryImportNativeCookie() {
  const script = process.env.LT_IMPORT_COOKIE_SCRIPT
    ? path.resolve(process.env.LT_IMPORT_COOKIE_SCRIPT)
    : path.resolve(process.cwd(), 'tools', 'import_cookie.py')
  if (process.platform !== 'darwin' || !fs.existsSync(script)) return false
  const result = spawnSync('python3', [script], { encoding: 'utf8', timeout: 15000 })
  if (result.status !== 0) return false
  return Boolean(loadCookie())
}

export function renderQrText(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const lines = []
  for (let row = 0; row < qr.getModuleCount(); row++) {
    let line = ''
    for (let col = 0; col < qr.getModuleCount(); col++) line += qr.isDark(row, col) ? '██' : '  '
    lines.push(line)
  }
  return lines.join('\n')
}

export function qrGifDataUrl(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createDataURL(10, 4)
}

export async function beginQrLogin() {
  const client = new NeteaseClient({ cookie: '' })
  const key = await client.loginQrUnikey()
  return {
    key,
    url: `https://music.163.com/login?codekey=${encodeURIComponent(key)}&type=3`,
    client,
  }
}

export async function pollQrLogin(session) {
  const result = await session.client.loginQrCheck(session.key)
  if (result.code === 803 && result.cookie) {
    saveCookie(result.cookie, 'qr')
    return { status: 'success', cookie: result.cookie }
  }
  if (result.code === 800) return { status: 'expired', message: '二维码已过期，请重新生成' }
  return { status: 'waiting', code: result.code, message: result.message || '' }
}

export async function waitForQrLogin(session, { timeoutMs = 180000, onStatus = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let result
    try {
      result = await pollQrLogin(session)
    } catch (error) {
      onStatus({ status: 'waiting', message: `网络波动，继续等待扫码：${error.message}` })
      await sleep(2000)
      continue
    }
    onStatus(result)
    if (result.status === 'success') return result.cookie
    if (result.status === 'expired') throw new Error(result.message)
    await sleep(2000)
  }
  throw new Error('扫码超时')
}

export function cookieToClient(cookie) {
  return new NeteaseClient({ cookie })
}
