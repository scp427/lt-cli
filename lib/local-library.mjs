import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const DB_PATH = path.join(
  os.homedir(),
  'Library/Containers/com.netease.163music/Data/Documents/storage/sqlite_storage.sqlite3',
)

let cache = null
let cacheAt = 0

function parseJson(text) {
  try { return JSON.parse(String(text ?? '')) } catch { return null }
}

function load() {
  if (cache && Date.now() - cacheAt < 60000) return cache
  if (!fs.existsSync(DB_PATH)) {
    cache = []
    cacheAt = Date.now()
    return cache
  }
  let db = null
  const tracks = new Map()
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true })
    for (const row of db.prepare('select id, jsonStr from dbTrack').all()) {
      const song = parseJson(row.jsonStr)
      if (!song) continue
      const id = Number(song.id ?? row.id)
      if (!id) continue
      tracks.set(id, {
        id,
        name: String(song.name ?? ''),
        artists: (song.artists ?? song.ar ?? []).map(item => String(item.name ?? '')).filter(Boolean),
        album: String(song.album?.name ?? song.al?.name ?? ''),
        playlists: [],
      })
    }
    const playlistNames = new Map()
    for (const row of db.prepare('select id, jsonStr from historyPlaylists').all()) {
      const playlist = parseJson(row.jsonStr)
      if (playlist?.id && playlist?.name) playlistNames.set(String(playlist.id), String(playlist.name))
    }
    for (const row of db.prepare('select id, jsonStr from playlistTrackIds').all()) {
      const data = parseJson(row.jsonStr)
      const name = playlistNames.get(String(row.id)) ?? data?.name
      if (!name || !Array.isArray(data?.trackIds)) continue
      for (const item of data.trackIds) {
        const id = Number(item?.id)
        const track = tracks.get(id)
        if (track && track.playlists.length < 8 && !track.playlists.includes(name)) track.playlists.push(name)
      }
    }
    cache = [...tracks.values()]
    cacheAt = Date.now()
    return cache
  } catch {
    cache = []
    cacheAt = Date.now()
    return cache
  } finally {
    try { db?.close() } catch {}
  }
}

export function searchLocal(keyword, { limit = 20 } = {}) {
  const query = String(keyword ?? '').trim().toLowerCase()
  if (!query) return []
  const all = load()
  const matched = all.filter(song => {
    const haystack = `${song.name} ${song.artists.join(' ')} ${song.album} ${song.playlists.join(' ')}`.toLowerCase()
    return haystack.includes(query)
  })
  return matched.slice(0, limit)
}

export function localStats() {
  const all = load()
  return { tracks: all.length, withPlaylist: all.filter(song => song.playlists.length).length }
}
