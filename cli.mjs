#!/usr/bin/env node
// lt-cli — 加入网易云官方多人一起听，并在 macOS 上同步播放音频。
import readline from 'node:readline/promises'
import { NeteaseError } from './lib/netease.mjs'
import { Session } from './lib/session.mjs'
import { checkDependencies, formatDependencies } from './lib/deps.mjs'
import {
  loadCookie, tryImportNativeCookie, renderQrText,
  beginQrLogin, waitForQrLogin, cookieToClient,
} from './lib/auth.mjs'

async function ensureLogin({ force = false } = {}) {
  let cookie = loadCookie()
  if (!cookie && tryImportNativeCookie()) cookie = loadCookie()
  if (cookie && !force) return cookie

  const qr = await beginQrLogin()
  console.log('\n本机没有找到可用的网易云登录态，请用 App 扫码登录：')
  console.log(renderQrText(qr.url))
  console.log(`如果扫不出来，打开：${qr.url}\n`)
  return waitForQrLogin(qr)
}

const help = () => console.log([
  '命令：',
  '  create            创建一起听房间并输出分享链接',
  '  status            查看房间、当前歌曲与同步状态',
  '  queue             查看待播队列',
  '  add [关键词|ID]    搜索并推歌到共同队列（直接给 ID 则跳过搜索）',
  '  lsearch <关键词>   只搜索桌面客户端缓存的本地歌单',
  '  playlists         查看我的歌单',
  '  daily             查看每日推荐',
  '  play <歌单ID>      列出歌单歌曲（用 add <ID> 推歌）',
  '  next              请求下一首',
  '  chat <文字>        发送房间消息',
  '  local <文件路径>   本机额外播放一个音频文件（其他成员听不到）',
  '  pause / resume    本机暂停 / 恢复',
  '  vol <0-100>       本机音量',
  '  quit              离开房间并退出',
].join('\n'))

async function main() {
  const deps = await checkDependencies()
  if (!deps.ok) {
    console.error(formatDependencies(deps))
    process.exit(1)
  }
  const args = process.argv.slice(2)
  let cookie = await ensureLogin({ force: args.includes('--login') })
  let client = cookieToClient(cookie)

  if (args.includes('--login') && !args.some(arg => !arg.startsWith('--'))) {
    console.log('登录完成。')
    return
  }

  let account = await client.account()
  if (!account.loggedIn) {
    cookie = await ensureLogin({ force: true })
    client = cookieToClient(cookie)
    account = await client.account()
  }
  console.log(`已登录：${account.name || account.userId}`)

  const inviteText = args.find(arg => !arg.startsWith('--'))

  const session = new Session({ cookie })
  session.on('song', value => console.log(`\n切歌：${value.songName || value.songId}`))
  session.on('error', ({ message, count }) => console.log(`[同步错误 ${count}] ${message}；将自动重连`))
  session.on('reconnected', () => console.log('已重新连接房间。'))
  session.on('ended', ({ reason }) => console.log(`房间结束：${reason}`))
  const shutdown = async signal => {
    console.log(`收到 ${signal}，正在离开房间…`)
    await session.leave().catch(() => {})
    process.exit(0)
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  if (inviteText) {
    console.log('检查邀请并加入房间…')
    await session.join(inviteText)
    console.log('已加入房间。输入 help 查看命令。')
  } else {
    console.log('未指定房间链接。输入 create 创建房间，或 join <分享链接> 加入。')
  }
  help()

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write('lt> ')
  for await (const rawLine of rl) {
    if (session.state.stopped) break
    const line = String(rawLine).trim()
    if (!line) { process.stdout.write('lt> '); continue }
    const [command, ...rest] = line.split(/\s+/)
    const argument = rest.join(' ').trim()
    try {
      if (command === 'create') {
        const result = await session.createRoom()
        console.log(`${result.alreadyInRoom ? '当前已在房间中' : '房间已创建'}：\n  官方链接：${result.officialLink}\n  程序链接：${result.link}`)
      } else if (command === 'join') {
        if (session.state.roomId && !session.state.stopped) await session.leave()
        await session.join(argument)
        console.log(`已加入房间：${session.state.roomId}`)
      } else if (command === 'quit' || command === 'exit') {
        await session.leave()
        break
      } else if (command === 'help' || command === '?') {
        help()
      } else if (command === 'status') {
        const s = session.status()
        console.log(`房间 ${s.roomId}｜在线 ${s.online}｜当前：${s.songName || '—'}`)
        console.log(`进度 ${(s.positionMs / 1000).toFixed(1)}s / ${(s.durationMs / 1000).toFixed(1)}s｜本地暂停：${s.localPaused ? '是' : '否'}`)
        if (s.members.length) console.log(`成员：${s.members.map(m => m.name || m.uid).join('、')}`)
        if (s.lastError) console.log(`上次错误：${s.lastError}`)
      } else if (command === 'queue') {
        const rows = await session.queue()
        if (!rows.length) console.log('待播队列为空。')
        for (const song of rows) console.log(`${song.songId}  ${song.name} — ${song.artists}`)
      } else if (command === 'add') {
        let songId = /^\d+$/.test(argument) ? Number(argument) : 0
        if (!songId) {
          const { online, local } = await session.search(argument || '流行', { onlineLimit: 6, localLimit: 4 })
          const results = [
            ...online.map(song => ({ ...song, source: '在线' })),
            ...local.map(song => ({ ...song, source: '本地缓存' })),
          ]
          if (!results.length) { console.log('没有搜到歌曲。'); continue }
          results.forEach((song, index) => console.log(`  ${index + 1}. [${song.source}] ${song.id}  ${song.name} — ${(song.artists ?? []).join(' / ')}`))
          const answer = (await rl.question('选择序号（默认 1）: ')).trim()
          const selected = results[Math.max(1, Number(answer) || 1) - 1] ?? results[0]
          songId = selected.id
          console.log(`推入：${selected.name}`)
        }
        const result = await session.add(songId)
        console.log(`已推歌，业务码：${result?.failedCode ?? 0}`)
      } else if (command === 'lsearch') {
        const results = await session.search(argument, { onlineLimit: 0, localLimit: 20 })
        if (!results.local.length) console.log('本地缓存里没有匹配歌曲。')
        for (const song of results.local) console.log(`  ${song.id}  ${song.name} — ${song.artists.join(' / ')}${song.playlists.length ? ` [${song.playlists.join('、')}]` : ''}`)
      } else if (command === 'playlists') {
        const rows = await session.playlists()
        for (const item of rows) console.log(`  ${item.id}  ${item.name}（${item.count} 首）`)
      } else if (command === 'daily') {
        const rows = await session.daily()
        for (const song of rows) console.log(`  ${song.id}  ${song.name} — ${song.artists.join(' / ')}${song.reason ? ` [${song.reason}]` : ''}`)
      } else if (command === 'play') {
        const data = await session.playlistTracks(Number(argument))
        console.log(`歌单：${data.name}`)
        for (const song of data.tracks) console.log(`  ${song.id}  ${song.name} — ${song.artists.join(' / ')}`)
      } else if (command === 'next') {
        const result = await session.next()
        console.log(`已请求下一首，业务码：${result?.failedCode ?? 0}`)
      } else if (command === 'chat') {
        await session.chat(argument)
        console.log('已发送。')
      } else if (command === 'local') {
        session.playLocal(argument)
        console.log('本机附加播放已启动（其他成员听不到）。')
      } else if (command === 'pause') {
        session.pause()
        console.log('已本机暂停。')
      } else if (command === 'resume') {
        await session.resume()
        console.log('已恢复并重新对齐进度。')
      } else if (command === 'vol') {
        session.volume(argument)
        console.log(`音量：${session.mpv.volume}`)
      } else {
        console.log(`未知命令：${command}`)
      }
    } catch (error) {
      console.log(`[错误] ${error instanceof NeteaseError ? `${error.code}: ${error.detail || error.message}` : error.message}`)
    }
    if (!session.state.stopped) process.stdout.write('lt> ')
  }

  if (!session.state.stopped) await session.leave()
  rl.close()
}

main().catch(error => {
  console.error(`[致命错误] ${error instanceof NeteaseError ? `${error.code}: ${error.detail || error.message}` : error.message}`)
  process.exit(1)
})
