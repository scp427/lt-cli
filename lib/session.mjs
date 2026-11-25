import path from 'node:path'
import os from 'node:os'
import { NeteaseClient, NeteaseError } from './netease.mjs'
import { MpvController } from './mpv.mjs'
import { searchLocal, localStats } from './local-library.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function parseInvite(text) {
  const raw = String(text ?? '').replace(/\\_/g, '_').replace(/\\&/g, '&').replace(/&amp;/g, '&')
  const urls = raw.match(/https?:\/\/[^\s<>"'，。；、）)\]]+/g) ?? []
  const candidates = urls.length ? urls : (/room_?id=/i.test(raw) ? [raw] : [])
  for (const candidate of candidates) {
    const clean = candidate.replace(/&/g, '&').replace(/[)\]}>"'，。；、]+$/, '')
    if (/163cn\.(tv|link)|url\.cn/i.test(clean)) return { url: clean, kind: 'short', roomId: '', inviterUid: '' }
    const room = /[?&#]room_?id=([A-Za-z0-9_-]{4,80})/i.exec(clean)
    if (!room) continue
    const inviterUid = /[?&#]inviter_?uid=(\d{1,20})/i.exec(clean)
    const inviterId = /[?&#]inviter_?id=(\d{1,20})/i.exec(clean)
    if (inviterUid) return { url: clean, kind: 'multi', roomId: room[1], inviterUid: inviterUid[1], inviterId: inviterId?.[1] ?? '' }
    if (inviterId) return { url: clean, kind: 'double', roomId: room[1], inviterId: inviterId[1], inviterUid: '' }
  }
  return null
}

async function resolveShortUrl(url) {
  try {
    const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
    return String(response.url ?? '')
  } catch {
    return ''
  }
}

function normalizeSnapshot(raw) {
  const data = raw && typeof raw === 'object' ? (raw.data ?? raw) : {}
  const snap = data.multiLtRoomSnapshot ?? data.roomSnapshot ?? data.roomInfo ?? data
  const play = snap.roomPlaySongInfo ?? data.roomPlaySongInfo ?? {}
  const song = play.playSong ?? snap.song ?? data.song ?? null
  const agg = snap.multiLtRoomUserAgg ?? data.multiLtRoomUserAgg ?? {}
  const members = []
  const push = value => {
    const uid = Number(value?.userId ?? value?.uid ?? 0)
    if (!uid || members.some(item => item.uid === uid)) return
    members.push({
      uid,
      name: String(value?.nickname ?? value?.nickName ?? ''),
      avatar: String(value?.avatar ?? value?.avatarUrl ?? ''),
    })
  }
  for (const item of agg.onlineUserInfos ?? []) push(item)
  for (const item of snap.roomUsers ?? []) push(item)
  return {
    status: String(data.status ?? snap.status ?? ''),
    roomId: String(snap.roomId ?? data.roomId ?? ''),
    chatRoomId: String(snap.multiRoomInfoDTO?.chatRoomId ?? snap.chatRoomId ?? data.chatroomId ?? ''),
    songId: Number(song?.songId ?? song?.id ?? play.songId ?? 0),
    bizId: String(song?.songBizId ?? play.songBizId ?? ''),
    songName: String(song?.title ?? song?.name ?? ''),
    artists: Array.isArray(song?.artistName) ? song.artistName.join(' / ') : String(song?.artistName ?? ''),
    playedTime: Number(play.playedTime ?? data.playedTime ?? 0),
    duration: Number(play.songDuration ?? data.songDuration ?? 0),
    version: Number(play.version ?? 0),
    forceSync: Boolean(play.forceSync),
    nextSongs: Array.isArray(play.nextSongs) ? play.nextSongs : [],
    members,
    onlineNums: Number(agg.onlineNums ?? members.length),
    heartBeatDuration: Number(data.heartBeatDuration ?? 0),
  }
}

export class Session {
  constructor({ cookie, log = () => {} } = {}) {
    this.log = log
    this.client = new NeteaseClient({ cookie })
    this.mpv = new MpvController(log, () => this.handlePlaybackEnded())
    this.endingHandled = false
    this.listeners = new Map()
    this.timer = null
    this.invite = null
    this.hostRoom = null
    this.chatBuffer = []
    this.meCache = null
    this.avatarCache = new Map()
    this.coverCache = new Map()
    this.errors = 0
    this.state = {
      roomId: '', songId: 0, bizId: '', version: 0, serverAt: 0,
      playedTime: 0, duration: 0, songName: '', artists: '', cover: '', localPaused: false,
      snapshot: null, stopped: false, busy: false, lastError: '',
      lastBeatAt: 0, joinedAt: 0,
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(handler)
    return () => this.listeners.get(event)?.delete(handler)
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      try { handler(payload) } catch {}
    }
  }

  expectedPosition() {
    if (!this.state.songId || !this.state.serverAt || this.state.localPaused) return this.state.playedTime
    return this.state.playedTime + Math.max(0, Date.now() - this.state.serverAt)
  }

  async handlePlaybackEnded() {
    if (this.state.stopped || !this.state.songId || this.endingHandled) return
    this.endingHandled = true
    setTimeout(async () => {
      try {
        const before = this.state.songId
        await this.refresh()
        // 房间已经切歌时 refresh 会重新起播；没切歌则重新拉一次音源，避免卡在结束状态。
        if (!this.state.stopped && this.state.songId === before && !this.state.localPaused) {
          const detail = await this.client.songUrl(this.state.songId).catch(() => null)
          if (detail?.url) await this.mpv.start(detail.url, this.expectedPosition() / 1000)
        }
      } catch (error) {
        this.handleError(error)
      } finally {
        this.endingHandled = false
      }
    }, 800)
  }

  resetRoomRuntime() {
    this.state.snapshot = null
    this.state.songId = 0
    this.state.bizId = ''
    this.state.songName = ''
    this.state.artists = ''
    this.state.cover = ''
    this.state.playedTime = 0
    this.state.duration = 0
    this.state.serverAt = 0
    this.state.version = 0
    this.state.localPaused = false
    this.endingHandled = false
    this.hostMisses = 0
    this.rejoinAttempts = 0
    this.chatBuffer = []
  }

  async join(inviteText) {
    let invite = parseInvite(inviteText)
    if (!invite) throw new Error('没有在文本里找到 roomId / inviterUid')
    if (invite.kind === 'short') {
      const expanded = await resolveShortUrl(invite.url)
      invite = expanded ? parseInvite(expanded) : null
    }
    if (!invite || invite.kind !== 'multi') throw new Error('这不是官方多人一起听链接（需要 inviterUid 且 isFLT=false）')
    this.invite = invite

    const preview = await this.client.multiPreview(invite.roomId, invite.inviterUid)
    if (String(preview?.roomStatus ?? '') === 'EXPIRED') throw new Error('邀请已过期，请让对方重新分享')

    const joined = await this.doAck()
    if (joined?.success === false) throw new Error(`加入失败：${joined.failedMessage ?? joined.failedType ?? '未知原因'}`)
    this.resetRoomRuntime()
    this.hostRoom = null
    this.state.joinedAt = Date.now()
    this.state.stopped = false
    this.emit('joined', this.status())
    await this.refresh()
    this.schedule()
    return this.status()
  }

  async createRoom() {
    const info = await this.client.createListenRoom()
    if (!info.roomId || !info.creatorId) throw new Error('创建房间失败：服务端没有返回 roomId / creatorId')
    const link = `https://st.music.163.com/listen-together/multishare/index.html?roomId=${encodeURIComponent(info.roomId)}&inviterUid=${info.creatorId}&isFLT=false`
    this.invite = {
      url: link,
      kind: 'multi',
      roomId: info.roomId,
      inviterUid: String(info.creatorId),
      inviterId: '',
    }
    this.state.roomId = info.roomId
    this.state.stopped = false
    this.resetRoomRuntime()
    this.hostRoom = {
      roomId: info.roomId, chatRoomId: info.chatRoomId, creatorId: info.creatorId, link,
      songIds: [], version: 1,
    }
    this.log(`${info.alreadyInRoom ? '当前已在房间中' : '房间已创建'}：${link}`)
    await this.me()
    await this.refresh()
    this.schedule()
    this.emit('joined', this.status())
    const officialLink = `https://st.music.163.com/listen-together/share/?songId=0&roomId=${encodeURIComponent(info.roomId)}&inviterId=${info.creatorId}`
    return { ...info, link, officialLink }
  }

  async doAck() {
    const joined = await this.client.multiAck({ roomId: this.invite.roomId, inviterUid: this.invite.inviterUid })
    this.state.roomId = String(joined?.roomId ?? this.invite.roomId)
    this.errors = 0
    this.state.lastError = ''
    return joined
  }

  async hostView() {
    const status = await this.client.listenStatus()
    const info = status?.data ?? {}
    if (!info.inRoom) return null
    const room = info.roomInfo ?? {}
    const played = await this.client.listenPlaylist(this.hostRoom.roomId)
    const pdata = played?.data ?? {}
    const ids = (pdata.playlist?.displayList?.result ?? []).map(String)
    this.hostRoom.songIds = ids
    this.hostRoom.version = Number(pdata.playlist?.version?.[0]?.version ?? this.hostRoom.version ?? 1)
    const play = pdata.playCommand ?? {}
    const me = await this.me()
    return {
      status: 'AVAILABLE',
      roomId: String(room.roomId ?? this.hostRoom.roomId),
      chatRoomId: String(room.chatRoomId ?? this.hostRoom.chatRoomId ?? ''),
      onlineNums: (room.roomUsers ?? []).length || 1,
      members: (room.roomUsers ?? []).map(user => ({
        uid: Number(user.userId ?? 0),
        name: String(user.nickname ?? ''),
        avatar: String(user.avatarUrl ?? ''),
      })).filter(user => user.uid),
      heartBeatDuration: 3,
      songId: Number(play.targetSongId ?? ids[0] ?? 0),
      bizId: 'host',
      version: Number(play.serverSeq ?? this.hostRoom.version),
      playedTime: Number(play.progress ?? 0),
      duration: 0,
      forceSync: false,
    }
  }

  async refresh() {
    const view = this.hostRoom
      ? await this.hostView()
      : normalizeSnapshot(await this.client.multiStatus())
    if (this.hostRoom && !view) {
      this.hostMisses = (this.hostMisses ?? 0) + 1
      if (this.hostMisses >= 3) {
        this.state.stopped = true
        this.emit('ended', { reason: '房间已结束' })
      }
      return
    }
    this.hostMisses = 0
    if (!this.hostRoom && (view.status === '488' || (!view.roomId && !view.songId))) {
      await this.rejoin()
      return
    }
    this.state.snapshot = view
    this.state.roomId = view.roomId || this.state.roomId
    if (!view.songId) {
      if (this.state.songId && !this.state.stopped) await this.mpv.stop()
      this.state.songId = 0
      this.state.songName = ''
      this.state.artists = ''
      this.state.cover = ''
      this.state.playedTime = 0
      this.state.duration = 0
      this.state.serverAt = 0
      this.state.version = Number(view.version ?? 0)
      this.rejoinAttempts = 0
      this.emit('status', this.status())
      return
    }
    const now = Date.now()
    // 本地暂停期间也要持续跟上房间进度，否则恢复对齐会落后。
    if (this.state.localPaused && view.songId === this.state.songId) {
      this.state.playedTime = view.playedTime
      this.state.duration = Number(this.state.duration || view.duration || 0)
      this.state.serverAt = now
    }
    const changed = view.songId && view.songId !== this.state.songId
    const drift = view.songId === this.state.songId
      ? Math.abs(view.playedTime - this.expectedPosition()) / 1000
      : 0
    if (changed) {
      const info = await this.client.song(view.songId).catch(() => null)
      const title = info?.name || view.songName || String(view.songId)
      const artist = info?.artists?.join(' / ') || view.artists
      this.log(`切歌：${title}${artist ? ` — ${artist}` : ''}`)
      const detail = await this.client.songUrl(view.songId).catch(() => null)
      if (!detail?.url) {
        this.log('这首歌拿不到音源（版权/地区/试听限制），本机静音，但仍在房间里。')
      } else if (!this.state.stopped) {
        const wasPaused = this.state.localPaused
        await this.mpv.start(detail.url, view.playedTime / 1000)
        if (wasPaused) this.mpv.pause(true)
        if (this.state.stopped) this.mpv.stop()
      }
      this.state.songId = view.songId
      this.state.bizId = view.bizId
      this.state.version = view.version
      this.state.playedTime = view.playedTime
      this.state.duration = Number(info?.duration ?? view.duration ?? 0)
      this.state.songName = info?.name || view.songName || String(view.songId)
      this.state.artists = info?.artists?.join(' / ') || view.artists
      this.state.cover = info?.cover || ''
      this.state.serverAt = now
      this.emit('song', this.status())
    } else if (view.version > this.state.version || (view.forceSync && drift > 1.5) || drift > 3.5) {
      this.state.playedTime = view.playedTime
      this.state.duration = Number(this.state.duration || view.duration || 0)
      this.state.version = view.version
      this.state.serverAt = now
      if (!this.state.localPaused) this.mpv.seek(view.playedTime / 1000)
    }
    this.rejoinAttempts = 0
    this.emit('status', this.status())
  }

  async rejoin() {
    if (!this.invite) {
      this.state.stopped = true
      this.emit('ended', { reason: '房间已结束' })
      return
    }
    this.rejoinAttempts = (this.rejoinAttempts ?? 0) + 1
    if (this.rejoinAttempts > 5) {
      this.state.stopped = true
      this.emit('ended', { reason: '多次重连失败' })
      return
    }
    this.log(`房间连接已断开，尝试重新加入（${this.rejoinAttempts}/5）…`)
    try {
      await this.doAck()
      this.state.songId = 0
      await this.refresh()
      this.emit('reconnected', this.status())
    } catch (error) {
      this.handleError(error)
    }
  }

  async beat() {
    if (this.hostRoom) {
      await this.client.listenHeartbeat({
        roomId: this.hostRoom.roomId,
        songId: this.state.songId,
        playStatus: this.state.localPaused ? 'PAUSE' : 'PLAY',
        progress: Math.round(this.expectedPosition()),
      })
    } else {
      await this.client.multiHeartbeat(this.state.roomId)
    }
    this.state.lastBeatAt = Date.now()
  }

  handleError(error) {
    this.errors += 1
    const message = error instanceof NeteaseError ? `${error.code}: ${error.detail || error.message}` : error.message
    this.state.lastError = message
    this.emit('error', { message, count: this.errors })
    const wait = Math.min(30000, 2000 * 2 ** Math.min(this.errors, 4))
    this.schedule(wait)
  }

  schedule(delayMs = 0) {
    clearTimeout(this.timer)
    if (this.state.stopped) return
    const seconds = Math.max(2, Math.min(10, this.state.snapshot?.heartBeatDuration || 3))
    const delay = delayMs || seconds * 1000
    this.timer = setTimeout(async () => {
      if (this.state.stopped || this.state.busy) { this.schedule(); return }
      this.state.busy = true
      try {
        await this.refresh()
        if (!this.state.stopped) await this.beat()
        this.errors = 0
        this.state.lastError = ''
      } catch (error) {
        this.handleError(error)
      } finally {
        this.state.busy = false
      }
    }, delay)
  }

  status() {
    const view = this.state.snapshot
    return {
      roomId: this.state.roomId,
      joined: Boolean(this.state.roomId && !this.state.stopped),
      isHost: Boolean(this.hostRoom),
      roomLink: this.hostRoom?.link || this.invite?.url || '',
      officialRoomLink: this.hostRoom
        ? `https://st.music.163.com/listen-together/share/?songId=${this.state.songId || this.hostRoom.songIds?.[0] || 0}&roomId=${encodeURIComponent(this.hostRoom.roomId)}&inviterId=${this.hostRoom.creatorId}`
        : '',
      me: this.meCache ? { userId: this.meCache.userId, name: this.meCache.name, avatar: this.meCache.avatar } : null,
      online: view?.onlineNums ?? 0,
      members: view?.members ?? [],
      chatRoomId: view?.chatRoomId ?? '',
      songId: this.state.songId,
      songName: this.state.songName,
      artists: this.state.artists || view?.artists || '',
      cover: this.state.cover,
      positionMs: Math.round(this.expectedPosition()),
      durationMs: this.state.duration,
      localPaused: this.state.localPaused,
      volume: this.mpv.volume,
      lastError: this.state.lastError,
      reconnectAttempts: this.errors,
      stopped: this.state.stopped,
    }
  }

  async avatarFor(uid, fallback = '') {
    const id = Number(uid ?? 0)
    if (!id) return ''
    if (this.avatarCache.has(id)) return this.avatarCache.get(id)
    let avatar = fallback
    if (!avatar) {
      const member = this.state.snapshot?.members?.find(item => Number(item.uid) === id)
      avatar = member?.avatar ?? ''
    }
    if (!avatar) {
      const detail = await this.client.userDetail(id).catch(() => null)
      avatar = detail?.avatar ?? ''
    }
    this.avatarCache.set(id, avatar)
    return avatar
  }

  async queue() {
    if (!this.state.roomId || this.state.stopped) return []
    if (this.hostRoom) {
      const me = await this.me()
      const rows = []
      for (const id of (this.hostRoom.songIds ?? []).slice(0, 50)) {
        const song = await this.client.song(id).catch(() => null)
        rows.push({
          songId: Number(id),
          bizId: 'host',
          name: song?.name || String(id),
          artists: song?.artists?.join(' / ') || '',
          cover: song?.cover || '',
          rcmdUid: me.userId,
          pusherName: me.name || '我',
          pusherAvatar: me.avatar || '',
          selfRcmd: true,
        })
      }
      return rows
    }
    const data = await this.client.multiQueue(this.state.roomId)
    const rows = data?.songLists ?? data?.songs ?? []
    return Promise.all(rows.slice(0, 50).map(async row => {
      const song = row.songInfo ?? row
      const rcmdUid = Number(row.rcmdUid ?? song.rcmdUid ?? 0)
      const pusherName = String(row.nickname ?? song.nickname ?? (rcmdUid ? '用户' : '系统推荐'))
      return {
        songId: Number(song.resourceId ?? song.id ?? 0),
        bizId: String(song.bizId ?? ''),
        name: String(song.title ?? song.name ?? ''),
        artists: Array.isArray(song.artistName) ? song.artistName.join(' / ') : String(song.artistName ?? ''),
        cover: String(song.coverUrl ?? ''),
        rcmdUid,
        pusherName,
        pusherAvatar: await this.avatarFor(rcmdUid),
        selfRcmd: Boolean(row.selfRcmd),
      }
    }))
  }

  async me() {
    if (!this.meCache) this.meCache = await this.client.account()
    return this.meCache
  }

  async playlists() {
    const me = await this.me()
    return this.client.userPlaylists(me.userId)
  }

  async playlistTracks(id) {
    return this.client.playlistDetail(id)
  }

  async daily() {
    return this.client.dailyRecommend()
  }

  async search(keyword, { onlineLimit = 8, localLimit = 8 } = {}) {
    const query = String(keyword ?? '').trim()
    if (!query) return { online: [], local: [] }
    const [onlineRaw, local] = await Promise.all([
      this.client.search(query, { limit: onlineLimit }).catch(() => []),
      Promise.resolve(searchLocal(query, { limit: localLimit })),
    ])
    // 搜索接口只给 picId，没有 picUrl；用歌曲详情补齐封面。
    const online = await Promise.all(onlineRaw.map(async song => {
      const detail = await this.client.song(song.id).catch(() => null)
      return { ...song, cover: song.cover || detail?.cover || '' }
    }))
    return { online, local }
  }

  async add(songId) {
    const id = Number(songId)
    if (!id) throw new Error('无效的歌曲 ID')
    this.log(`推歌：${id}`)
    if (this.hostRoom) {
      const me = await this.me()
      const existing = (this.hostRoom.songIds ?? []).map(String)
      const wasEmpty = existing.length === 0
      const songIds = existing.includes(String(id)) ? existing : [...existing, String(id)]
      const version = Date.now()
      const result = await this.client.listenSyncList({ roomId: this.hostRoom.roomId, userId: me.userId, songIds, version })
      if (result?.data?.result === true || result?.code === 200) {
        this.hostRoom.songIds = songIds
        this.hostRoom.version = version
      }
      if (wasEmpty || !this.state.songId) {
        await this.client.listenPlayCommand({
          roomId: this.hostRoom.roomId,
          commandType: 'PLAY',
          formerSongId: '-1',
          targetSongId: id,
          progress: 0,
          playStatus: 'PLAY',
        })
        await this.refresh()
      }
      this.emit('added', { songId: id, result })
      return { failedCode: 0 }
    }
    const result = await this.client.multiOperate({ roomId: this.state.roomId, songId: id, operate: 1 })
    this.emit('added', { songId: id, result })
    return result
  }

  async next() {
    this.log('请求下一首')
    if (this.hostRoom) {
      const ids = this.hostRoom.songIds ?? []
      const index = ids.findIndex(id => Number(id) === Number(this.state.songId))
      const target = ids[index + 1] ?? ids[0] ?? 0
      const result = await this.client.listenPlayCommand({
        roomId: this.hostRoom.roomId,
        commandType: 'GOTO',
        formerSongId: '-1',
        targetSongId: target,
        progress: 0,
        playStatus: 'PLAY',
      })
      await this.refresh()
      return { failedCode: result?.code === 200 ? 0 : 1 }
    }
    const result = await this.client.multiOperate({
      roomId: this.state.roomId, songId: this.state.songId, bizId: this.state.bizId, operate: 4,
    })
    return result
  }

  // operate=7 是官方队列删除。只允许取消自己推荐的条目。
  async cancel({ songId, bizId, rcmdUid = 0, selfRcmd = false }) {
    const me = await this.me()
    if (!selfRcmd && Number(rcmdUid) !== Number(me.userId)) {
      throw new Error('只能取消自己推荐的歌曲')
    }
    this.log(`取消推歌：${songId}`)
    if (this.hostRoom) {
      const me = await this.me()
      const songIds = (this.hostRoom.songIds ?? []).filter(id => Number(id) !== Number(songId))
      const version = Date.now()
      const result = await this.client.listenSyncList({ roomId: this.hostRoom.roomId, userId: me.userId, songIds, version })
      if (result?.data?.result === true || result?.code === 200) {
        this.hostRoom.songIds = songIds
        this.hostRoom.version = version
      }
      return { failedCode: 0 }
    }
    return this.client.multiOperate({
      roomId: this.state.roomId, songId: Number(songId), bizId: String(bizId ?? ''), operate: 7,
    })
  }

  async chat(text) {
    const chatRoomId = this.state.snapshot?.chatRoomId
    if (!chatRoomId) throw new Error('拿不到房间聊天室 ID，暂时不能发言')
    this.log(`发送消息：${String(text).slice(0, 40)}`)
    const result = this.hostRoom
      ? await this.client.listenChatSend({ roomId: this.hostRoom.roomId, chatroomId: chatRoomId, text: String(text) })
      : await this.client.multiChatSend({ roomId: this.state.roomId, chatroomId: chatRoomId, text: String(text) })
    const me = await this.me()
    this.chatBuffer.push({ uid: me.userId, name: me.name || '我', time: Date.now(), text: String(text) })
    if (this.chatBuffer.length > 200) this.chatBuffer = this.chatBuffer.slice(-200)
    return result
  }

  async chatHistory(size = 30) {
    if (!this.state.roomId || this.state.stopped) return []
    const data = await this.client.multiChatHistory(this.state.roomId, size)
    const rows = Array.isArray(data?.records) ? data.records : []
    const history = rows.slice(-size).map(row => ({
      uid: Number(row.sendUid ?? 0),
      name: String(row.nickname ?? ''),
      time: Number(row.sendTime ?? 0),
      text: String(row?.imChatRoomMsgBody?.text ?? ''),
    }))
    const key = message => `${message.uid}|${message.text}|${Math.floor(message.time / 1000)}`
    const seen = new Set()
    return [...history, ...this.chatBuffer]
      .filter(message => message.text)
      .filter(message => {
        const id = key(message)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .sort((a, b) => a.time - b.time)
      .slice(-size)
  }

  playLocal(filePath) {
    const fullPath = path.resolve(String(filePath).replace(/^~/, os.homedir()))
    this.log(`本机附加播放：${fullPath}`)
    this.mpv.playLocal(fullPath)
  }

  pause() {
    const position = this.expectedPosition()
    this.state.playedTime = position
    this.state.serverAt = Date.now()
    this.state.localPaused = true
    this.mpv.pause(true)
    this.log(`本机暂停，进度 ${(position / 1000).toFixed(1)}s`)
  }

  async resume() {
    const targetMs = this.expectedPosition()
    this.log(`恢复播放，进度 ${(targetMs / 1000).toFixed(1)}s`)
    if (this.state.songId && !this.state.stopped) {
      const detail = await this.client.songUrl(this.state.songId).catch(() => null)
      if (detail?.url) {
        await this.mpv.start(detail.url, targetMs / 1000)
        this.state.playedTime = targetMs
        this.state.serverAt = Date.now()
        this.state.localPaused = false
      } else {
        this.log('恢复失败：暂时拿不到音源，请稍后重试')
      }
    } else {
      this.state.localPaused = false
    }
  }

  volume(value) {
    this.mpv.setVolume(value)
    this.log(`音量：${this.mpv.volume}`)
  }

  localStats() {
    return localStats()
  }

  async leave() {
    this.log('离开房间')
    clearTimeout(this.timer)
    this.timer = null
    const leavingRoomId = this.state.roomId
    const wasHost = Boolean(this.hostRoom)
    this.state.stopped = true
    await this.mpv.stop()
    this.mpv.stopLocal()
    if (leavingRoomId) {
      if (wasHost) await this.client.listenEnd(leavingRoomId).catch(() => {})
      else await this.client.multiExit(leavingRoomId).catch(() => {})
    }
    this.state.roomId = ''
    this.invite = null
    this.hostRoom = null
    this.resetRoomRuntime()
    this.emit('ended', { reason: '主动离开' })
  }
}
