import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PROFILE_DIR = path.join(os.homedir(), '.lt-cli', 'profiles')
function ensureProfileDir() { fs.mkdirSync(PROFILE_DIR, { recursive: true }) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const short = (value, n = 160) => {
  const text = String(value ?? '')
  return text.length > n ? text.slice(0, n) + '…' : text
}

export class MpvController {
  constructor(log = () => {}, onEnded = () => {}) {
    this.log = log
    this.onEnded = onEnded
    this.child = null
    this.children = new Set()
    this.socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\lt-cli-${process.pid}-${Math.random().toString(36).slice(2, 7)}`
      : path.join(PROFILE_DIR, `mpv-${process.pid}-${Math.random().toString(36).slice(2, 7)}.sock`)
    this.socket = null
    this.buffer = ''
    this.volume = 80
    this.localChild = null
    this.startChain = Promise.resolve()
  }

  start(url, startSec = 0) {
    const next = this.startChain.then(() => this._start(url, startSec))
    this.startChain = next.catch(() => {})
    return next
  }

  async _start(url, startSec = 0) {
    ensureProfileDir()
    await this.stop()
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath) } catch {}
    }
    const args = [
      '--no-config', '--force-window=no', '--audio-display=no', '--idle=yes',
      '--keep-open=no', '--msg-level=all=error',
      `--input-ipc-server=${this.socketPath}`,
      `--volume=${this.volume}`,
      `--start=${Math.max(0, startSec).toFixed(2)}`,
      String(url),
    ]
    this.child = spawn('mpv', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const child = this.child
    this.children.add(child)
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) this.log(`[mpv] ${short(text)}`)
    })
    child.on('exit', () => {
      this.children.delete(child)
      if (this.child === child) this.child = null
    })
    await this.connect()
    // mpv 在 --idle=yes 下有时只把 URL 放进播放列表而不自动开始，显式启动第一条。
    this.command('playlist-play-index', 0)
  }

  async connect() {
    ensureProfileDir()
    for (let attempt = 0; attempt < 30; attempt++) {
      if (process.platform === 'win32' || fs.existsSync(this.socketPath)) {
        try {
          this.socket = net.createConnection(this.socketPath)
          await new Promise((resolve, reject) => {
            this.socket.once('connect', resolve)
            this.socket.once('error', reject)
          })
          this.socket.on('data', chunk => {
            this.buffer += String(chunk)
            const lines = this.buffer.split('\n')
            this.buffer = lines.pop() ?? ''
            for (const line of lines) {
              try {
                const message = JSON.parse(line)
                if (message.event === 'end-file' && ['eof', 'eof-reached'].includes(message.reason)) {
                  this.onEnded()
                }
              } catch {}
            }
          })
          return
        } catch {}
      }
      await sleep(100)
    }
    throw new Error('无法连接 mpv 控制接口')
  }

  command(...args) {
    if (!this.socket || this.socket.destroyed) return
    this.socket.write(JSON.stringify({ command: args }) + '\n')
  }

  seek(seconds) {
    this.command('seek', Number(seconds.toFixed(2)), 'absolute+exact')
  }

  pause(value) {
    this.command('set_property', 'pause', Boolean(value))
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(100, Number(value) || 0))
    this.command('set_property', 'volume', this.volume)
  }

  async stop() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    const children = [...this.children]
    for (const child of children) {
      try { if (child.exitCode === null) child.kill('SIGTERM') } catch {}
    }
    await Promise.race([
      Promise.all(children.map(child => child.exitCode === null
        ? new Promise(resolve => child.once('exit', resolve))
        : Promise.resolve())),
      sleep(500),
    ])
    for (const child of children) {
      try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}
    }
    if (children.length) await sleep(50)
    this.children.clear()
    this.child = null
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath) } catch {}
    }
  }

  playLocal(filePath) {
    this.stopLocal()
    this.localChild = spawn('mpv', [
      '--no-config', '--force-window=no', `--volume=${this.volume}`,
      '--msg-level=all=error', String(filePath),
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.localChild.stderr.on('data', chunk => {
      const text = String(chunk).trim()
      if (text) this.log(`[local mpv] ${short(text)}`)
    })
    this.localChild.on('exit', () => { this.localChild = null })
  }

  stopLocal() {
    const child = this.localChild
    if (child && !child.killed) {
      child.kill('SIGTERM')
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill('SIGKILL') } catch {}
      }, 300)
    }
    this.localChild = null
  }
}
