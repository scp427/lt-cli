#!/usr/bin/env node
// 本地 Web UI：node ui.mjs "<分享链接>"
import http from 'node:http'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { NeteaseClient, NeteaseError } from './lib/netease.mjs'
import { Session } from './lib/session.mjs'
import { checkDependencies, formatDependencies, installDependency } from './lib/deps.mjs'
import {
  loadCookie, tryImportNativeCookie, beginQrLogin,
  pollQrLogin, qrGifDataUrl,
} from './lib/auth.mjs'

const args = process.argv.slice(2)
const inviteText = args.find(arg => !arg.startsWith('--'))
const portArg = args.find(arg => arg.startsWith('--port='))
let port = Number(portArg?.split('=')[1] ?? 8765)

async function bootstrap() {
const rl = process.stdin.isTTY
  ? readline.createInterface({ input: process.stdin, output: process.stdout })
  : null

let deps = await checkDependencies()
console.log(formatDependencies(deps))
if (!deps.ok) {
  const missing = deps.items.filter(item => !item.ok)
  const auto = missing.filter(item => item.install)
  if (rl && auto.length) {
    const answer = (await rl.question(`依赖缺失，是否自动安装 [${auto.map(item => item.name).join('、')}]？[y/N] `)).trim()
    if (/^y(es)?$/i.test(answer)) {
      for (const item of auto) {
        console.log(`正在安装 ${item.name}：${item.install}`)
        installDependency(item.install)
      }
      deps = await checkDependencies()
      console.log(formatDependencies(deps))
    }
  }
  if (!deps.ok) {
    if (!rl) console.log('非交互环境无法自动安装，请按上面的提示手动安装后重试。')
    rl?.close()
    process.exit(1)
  }
}
if (args.includes('--deps-check-only')) {
  rl?.close()
  process.exit(0)
}

function serveQrLogin(qr) {
  return new Promise((resolve, reject) => {
    const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>扫码登录</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f5f6f8;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border-radius:14px;padding:28px 36px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}
img{width:260px;height:260px;image-rendering:pixelated}h1{font-size:18px;color:#ec4141}p{color:#888;font-size:13px}</style></head>
<body><div class="box"><h1>网易云音乐扫码登录</h1><img src="${qrGifDataUrl(qr.url)}" alt="二维码"><p id="msg">请用 App 扫一扫，登录成功后会自动继续</p></div>
<script>async function poll(){const r=await fetch('/status');const d=await r.json();if(d.status==='success'){document.getElementById('msg').textContent='登录成功，正在启动…';location.reload()}else{document.getElementById('msg').textContent=d.message||'等待扫码…';setTimeout(poll,1500)}}poll()</script></body></html>`

    const server = http.createServer(async (req, res) => {
      if (req.url === '/status') {
        try {
          const result = await pollQrLogin(qr)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
          if (result.status === 'success') finish()
          if (result.status === 'expired') reject(new Error(result.message))
        } catch (error) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'error', message: error.message }))
        }
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page)
    })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      server.close(() => resolve(loadCookie()))
    }
    server.on('error', error => {
      if (error.code === 'EADDRINUSE' && port < 8775) {
        port += 1
        setTimeout(() => server.listen(port, '127.0.0.1'), 50)
      } else reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`扫码登录页面: http://127.0.0.1:${port}/`)
    })
  })
}

console.log('\n用户认证检查：')
let cookie = loadCookie()
let auth = null
if (cookie) {
  auth = await new NeteaseClient({ cookie }).account().catch(() => null)
  if (auth?.loggedIn) {
    console.log(`  ✓ 已找到本机登录态：${auth.name || auth.userId}（UID ${auth.userId}）`)
  } else {
    console.log('  ✗ 本机登录态已失效')
    cookie = ''
  }
} else if (tryImportNativeCookie()) {
  cookie = loadCookie()
  auth = cookie ? await new NeteaseClient({ cookie }).account().catch(() => null) : null
  if (auth?.loggedIn) console.log(`  ✓ 已从原生客户端导入登录态：${auth.name || auth.userId}`)
}
if (!cookie) {
  console.log('  ✗ 未找到可用登录态，将打开扫码页面')
  cookie = await serveQrLogin(await beginQrLogin())
  auth = await new NeteaseClient({ cookie }).account().catch(() => null)
  console.log(`  ✓ 扫码登录成功：${auth?.name || auth?.userId || '已登录'}`)
}
const session = new Session({ cookie, log: message => console.log(message) })
session.on('error', ({ message, count }) => console.log(`[重连 ${count}] ${message}`))
session.on('reconnected', () => console.log('已重新连接房间'))
const shutdown = async signal => {
  console.log(`收到 ${signal}，正在离开房间…`)
  await session.leave().catch(() => {})
  process.exit(0)
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
await session.me()

async function joinRoom(link) {
  if (session.state.roomId && !session.state.stopped) await session.leave()
  await session.join(link)
  console.log(`已加入房间：${session.state.roomId}`)
  return session.status()
}

if (inviteText) {
  console.log('正在加入房间…')
  await joinRoom(inviteText)
} else {
  console.log('未指定房间链接。启动后可在网页里输入链接加入，或在终端输入：join <链接>')
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>一起听 · 控制台</title>
<style>
:root{--red:#ec4141;--red-dark:#c62f2f;--bg:#f5f6f8;--card:#fff;--line:#ececf0;--text:#333;--muted:#999;--blue:#3b82f6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.side{display:none}
.logo{width:40px;height:40px;border-radius:50%;background:#fff;color:var(--red);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;margin-bottom:22px}
.nav{width:100%;text-align:center;padding:11px 0;font-size:12px;color:rgba(255,255,255,.75);cursor:pointer}
.nav.on,.nav:hover{background:rgba(0,0,0,.12);color:#fff}
.top{height:60px;background:var(--red);margin-left:0;display:flex;align-items:center;padding:0 22px;gap:12px;position:sticky;top:0;z-index:9;color:#fff}
.top .dot{width:30px;height:30px;border-radius:50%;background:rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center}
.top input{border:0;border-radius:16px;background:rgba(255,255,255,.9);padding:7px 14px;width:280px;outline:0}
.top .me{margin-left:auto;display:flex;align-items:center;gap:8px}
.top .me img{width:30px;height:30px;border-radius:50%;object-fit:cover}
main{margin-left:0;padding:18px 22px 40px;max-width:1500px}
.hero{background:linear-gradient(135deg,#fff 0%,#fff8f8 100%);border:1px solid var(--line);border-radius:14px;padding:22px;display:grid;grid-template-columns:210px 1fr 260px;gap:24px;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.04)}
.disc{position:relative;width:190px;height:190px;border-radius:50%;background:radial-gradient(circle at center,#333 0 18%,#111 19% 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.disc::after{content:"";position:absolute;inset:22px;border-radius:50%;background:linear-gradient(45deg,#444,#111);opacity:.6}
.disc img{position:relative;width:126px;height:126px;border-radius:50%;object-fit:cover;z-index:2;animation:spin 14s linear infinite}
.disc.paused img{animation-play-state:paused}
@keyframes spin{to{transform:rotate(360deg)}}
.songtitle{font-size:26px;font-weight:700;margin:2px 0 4px}
.artist{color:var(--muted);margin-bottom:14px}
.bar{height:5px;background:#e8e8ec;border-radius:99px;overflow:hidden;max-width:560px}
.bar i{display:block;height:100%;background:var(--red);width:0;transition:width .8s linear}
.row{display:flex;justify-content:space-between;max-width:560px;color:var(--muted);font-size:12px;margin-top:6px}
.controls{display:flex;flex-wrap:wrap;gap:9px;margin-top:18px}
button{border:1px solid var(--line);background:#fff;border-radius:18px;padding:7px 14px;cursor:pointer;color:#444}
button:hover{border-color:var(--red);color:var(--red)}
button.primary{background:var(--red);border-color:var(--red);color:#fff}
button.danger{color:var(--red)}
input,select{border:1px solid var(--line);border-radius:16px;padding:7px 12px;outline:0;background:#fff;color:var(--text)}
input[type=range]{padding:0;width:110px;vertical-align:middle}
.members{display:flex;flex-wrap:wrap;gap:12px;justify-content:flex-start}
.member{text-align:center;width:62px}
.member img{width:44px;height:44px;border-radius:50%;object-fit:cover;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.12)}
.member span{display:block;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.03)}
.card h2{font-size:14px;margin:0 0 14px;color:#444;font-weight:650}
.card h2 a{float:right;font-size:12px;color:var(--red);cursor:pointer;font-weight:400}
.searchbar{display:flex;gap:8px;margin-bottom:12px}.searchbar input{flex:1}
.list{list-style:none;margin:0;padding:0;max-height:280px;overflow:auto}
.list li{padding:8px 4px;border-bottom:1px solid #f3f3f5;display:flex;align-items:center;gap:10px}
.list li:last-child{border:0}
.thumb{width:38px;height:38px;border-radius:6px;object-fit:cover;background:#f0f0f2;flex:none}
.avatar{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#f0f0f2;flex:none}
.ph{display:inline-flex;align-items:center;justify-content:center;background:#ffecec;color:var(--red);font-size:11px}
.grow{flex:1;min-width:0}
.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.action{color:var(--red);cursor:pointer;font-size:12px;white-space:nowrap}
.chatbox{height:210px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:10px;background:#fbfbfc}
.chatline{margin-bottom:7px}.chatline b{color:var(--blue)}
.send{display:flex;gap:8px;margin-top:10px}.send input{flex:1}
.badge{display:inline-block;background:#fff0f0;color:var(--red);border-radius:10px;padding:1px 8px;font-size:11px;margin-left:6px}
.err{background:#fff0f0;color:var(--red);padding:4px 10px;border-radius:12px;font-size:12px;display:none}
@media(max-width:1000px){.hero{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.top input{width:160px}}
</style>
</head>
<body>
<aside class="side">
  <div class="logo">云</div>
  <div class="nav on">发现</div><div class="nav">播客</div><div class="nav">视频</div>
  <div class="nav">关注</div><div class="nav">直播</div><div class="nav">私人FM</div>
</aside>
<div class="top">
  <div class="me"><img id="meAvatar" src="" alt=""><span id="meName"></span></div>
</div>
<main>
  <section class="card" id="joinCard" style="display:none;margin-bottom:16px">
    <h2>加入一起听房间</h2>
    <div class="searchbar"><input id="joinLink" placeholder="粘贴 multishare 分享链接"><button class="primary" id="btnJoin">加入房间</button></div>
    <div class="controls" style="margin:0 0 8px"><button id="btnCreate">创建房间并生成链接</button><button id="btnCopyLink" style="display:none">复制链接</button></div>
    <input id="roomLink" readonly style="display:none;width:100%" placeholder="创建好的房间链接">
    <div class="mini" id="joinHint">也可以直接在启动时传入链接，或在终端输入 join &lt;链接&gt;</div>
  </section>
  <section class="hero">
    <div class="disc" id="disc"><img id="cover" src="" alt="封面"></div>
    <div>
      <div class="mini"><span id="playLabel">暂无歌曲</span> <span class="badge" id="conn">连接中…</span></div>
      <div class="songtitle" id="song">—</div>
      <div class="artist" id="artist"></div>
      <div class="bar"><i id="progress"></i></div>
      <div class="row"><span id="pos">0:00</span><span id="dur">0:00</span></div>
      <div class="controls">
        <button id="btnPause">暂停</button><button id="btnResume">恢复对齐</button>
        <button id="btnNext">下一首</button>
        <label class="mini">音量 <input type="range" id="vol" min="0" max="100" value="80"></label>
        <button class="danger" id="btnQuit">离开房间</button>
      </div>
      <div class="err" id="err"></div>
    </div>
    <div>
      <h2 style="font-size:13px;color:#666;margin:0 0 12px">房间成员 <span class="badge" id="online">0</span></h2>
      <div class="members" id="members"></div>
      <div id="roomLinkBar" style="display:none;margin-top:14px">
        <div class="mini" style="margin-bottom:4px">官方房间链接（网易云 App）</div>
        <input id="officialRoomLinkText" readonly style="width:100%">
        <button id="btnCopyOfficialRoomLink" style="margin:6px 0 10px">复制官方链接</button>
        <div class="mini" style="margin-bottom:4px">程序链接（multishare）</div>
        <input id="roomLinkText" readonly style="width:100%">
        <button id="btnCopyRoomLink" style="margin-top:6px">复制程序链接</button>
      </div>
    </div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>搜索并推歌</h2>
      <div class="searchbar"><input id="q" placeholder="歌名 / 歌手 / 本地歌单"><button class="primary" id="btnSearch">搜索</button></div>
      <div class="mini" id="searchHint">在线 + 本机缓存一起搜</div>
      <ul class="list" id="results"></ul>
    </section>

    <section class="card">
      <h2>我的音乐 <a id="btnDaily">每日推荐</a></h2>
      <div class="controls" style="margin:0 0 10px"><button id="btnPlaylists">我的歌单</button><span class="mini" id="libHint">点歌单看歌曲</span></div>
      <ul class="list" id="library"></ul>
    </section>

    <section class="card">
      <h2>待播队列 <a id="btnQueue">刷新</a></h2>
      <ul class="list" id="queue"></ul>
    </section>

    <section class="card">
      <h2>房间聊天</h2>
      <div class="chatbox" id="chat"></div>
      <div class="send"><input id="chatText" placeholder="发条消息…"><button class="primary" id="btnChat">发送</button></div>
      <div class="send"><input id="localPath" placeholder="本机音频文件绝对路径"><button id="btnLocal">播放</button></div>
    </section>
  </div>
</main>
<script>
const $=id=>document.getElementById(id)
let meUserId=0
let currentSongId=0
const BLANK='data:image/gif;base64,R0lGODlhAQABAAAAACw='
const img=u=>u?String(u).replace(/^http:/,'https:'):BLANK
const fmt=ms=>{const s=Math.max(0,Math.round(ms/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function api(url,opts){const r=await fetch(url,opts);const d=await r.json().catch(()=>({}));if(!r.ok||d.error)throw new Error(d.error||('HTTP '+r.status));return d}
async function refresh(){
  try{
    const s=await api('/api/status')
    $('conn').textContent=s.joined?'已连接':(s.stopped?'已离开':'未加入房间')
    $('joinCard').style.display=s.joined?'none':'block'
    currentSongId=s.songId||0
    if(s.roomLink){$('roomLinkBar').style.display='block';$('roomLinkText').value=s.roomLink;$('officialRoomLinkText').value=s.officialRoomLink||''}else{$('roomLinkBar').style.display='none';$('roomLinkText').value='';$('officialRoomLinkText').value=''}
    $('playLabel').textContent=s.songId?'正在播放':'等待推歌'
    $('song').textContent=s.songName||'—';$('artist').textContent=s.artists||''
    const cover=img(s.cover);if(cover&&$('cover').src!==cover)$('cover').src=cover
    $('disc').className='disc'+(s.localPaused?' paused':'')
    $('pos').textContent=fmt(s.positionMs);$('dur').textContent=fmt(s.durationMs)
    $('progress').style.width=(s.durationMs?Math.min(100,s.positionMs/s.durationMs*100):0)+'%'
    $('online').textContent=s.online
    $('members').innerHTML=(s.members||[]).map(m=>'<div class="member"><img src="'+img(m.avatar)+'" alt=""><span>'+esc(m.name||m.uid)+'</span></div>').join('')
    $('err').style.display=s.lastError?'block':'none';$('err').textContent=s.lastError||''
    if(s.me){meUserId=s.me.userId;$('meName').textContent=s.me.name;const a=img(s.me.avatar);if(a)$('meAvatar').src=a}
    if(document.activeElement!==$('vol'))$('vol').value=s.volume
  }catch(e){$('conn').textContent='连接失败'}
}
async function loadChat(){
  try{
    const c=await api('/api/chat')
    const box=$('chat')
    const nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<60
    box.innerHTML=c.map(x=>'<div class="chatline"><b>'+esc(x.name||x.uid)+'</b> '+esc(x.text)+'</div>').join('')
    if(nearBottom)box.scrollTop=box.scrollHeight
  }catch(e){}
}
function pushButton(id){return '<a class="action" data-id="'+id+'">推歌</a>'}
function bindPush(root){root.querySelectorAll('a[data-id]').forEach(a=>a.onclick=async()=>{try{await api('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({songId:Number(a.dataset.id)})});a.textContent='已推';loadQueue()}catch(e){alert(e.message)}})}
function avatarHtml(a){return a?'<img class="avatar" src="'+img(a)+'" alt="">':'<span class="avatar ph">系</span>'}
function queueAction(x){
  const mine=x.selfRcmd||(meUserId&&x.rcmdUid===meUserId)
  return mine?'<a class="action cancel" data-cancel="1" data-songid="'+x.songId+'" data-bizid="'+esc(x.bizId)+'" data-uid="'+x.rcmdUid+'">取消</a>':''
}
async function loadQueue(){
  try{
    const rows=await api('/api/queue')
    $('queue').innerHTML=rows.length?rows.map(x=>'<li><img class="thumb" src="'+img(x.cover)+'" alt=""><div class="grow"><div class="title">'+esc(x.name)+(x.songId===currentSongId?'<span class="badge">播放中</span>':'')+'</div><div class="mini">'+esc(x.artists)+'</div></div>'+avatarHtml(x.pusherAvatar)+'<span class="mini">'+esc(x.pusherName)+'</span>'+queueAction(x)+'</li>').join(''):'<li class="mini">队列为空</li>'
    $('queue').querySelectorAll('a[data-cancel]').forEach(a=>a.onclick=async()=>{
      if(!confirm('确定从队列取消这首歌？'))return
      try{
        await api('/api/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({songId:Number(a.dataset.songid),bizId:a.dataset.bizid,rcmdUid:Number(a.dataset.uid),selfRcmd:true})})
        a.textContent='已取消';loadQueue()
      }catch(e){alert(e.message)}
    })
  }catch(e){}
}
async function search(){
  const q=$('q').value.trim()
  if(!q)return
  $('searchHint').textContent='搜索中…'
  try{
    const d=await api('/api/search?q='+encodeURIComponent(q))
    const rows=[...(d.online||[]).map(x=>({...x,source:'在线'})),...(d.local||[]).map(x=>({...x,source:'本地缓存'}))]
    $('results').innerHTML=rows.length?rows.map(x=>'<li><img class="thumb" src="'+img(x.cover)+'" alt=""><div class="grow"><div class="title">'+esc(x.name)+'</div><div class="mini">['+x.source+'] '+esc((x.artists||[]).join(' / '))+'</div></div>'+pushButton(x.id)+'</li>').join(''):'<li class="mini">没有结果</li>'
    bindPush($('results'));$('searchHint').textContent='共 '+rows.length+' 条结果'
  }catch(e){$('searchHint').textContent=e.message}
}
$('btnSearch').onclick=search
$('q').addEventListener('keydown',e=>{if(e.key==='Enter')search()})
$('btnQueue').onclick=loadQueue
$('btnJoin').onclick=async()=>{
  const link=$('joinLink').value.trim()
  if(!link){$('joinHint').textContent='请先粘贴分享链接';return}
  $('joinHint').textContent='正在加入…';$('chat').innerHTML=''
  try{await api('/api/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({link})});$('joinHint').textContent='已加入';refresh();loadChat();loadQueue()}
  catch(e){$('joinHint').textContent=e.message}
}
$('btnCreate').onclick=async()=>{
  $('joinHint').textContent='正在创建房间…';$('chat').innerHTML=''
  try{
    const d=await api('/api/create-room',{method:'POST'})
    $('roomLink').value=d.link;$('roomLink').style.display='block';$('btnCopyLink').style.display='inline-block'
    $('joinHint').textContent=d.alreadyInRoom?'当前已在房间中，这是现有房间链接':'房间已创建，把链接发给朋友即可加入'
    refresh();loadChat();loadQueue()
  }catch(e){$('joinHint').textContent=e.message}
}
async function copyText(text){
  try{await navigator.clipboard.writeText(text)}catch(e){const box=document.createElement('textarea');box.value=text;document.body.appendChild(box);box.select();document.execCommand('copy');box.remove()}
}
$('btnCopyLink').onclick=async()=>{await copyText($('roomLink').value);$('joinHint').textContent='链接已复制'}
$('btnCopyRoomLink').onclick=async()=>{await copyText($('roomLinkText').value);$('btnCopyRoomLink').textContent='已复制';setTimeout(()=>$('btnCopyRoomLink').textContent='复制程序链接',1500)}
$('btnCopyOfficialRoomLink').onclick=async()=>{await copyText($('officialRoomLinkText').value);$('btnCopyOfficialRoomLink').textContent='已复制';setTimeout(()=>$('btnCopyOfficialRoomLink').textContent='复制官方链接',1500)}
$('btnPause').onclick=()=>api('/api/pause',{method:'POST'})
$('btnResume').onclick=()=>api('/api/resume',{method:'POST'})
$('btnNext').onclick=async()=>{try{await api('/api/next',{method:'POST'});loadQueue()}catch(e){alert(e.message)}}
$('vol').oninput=e=>api('/api/vol',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:Number(e.target.value)})})
$('btnChat').onclick=async()=>{const text=$('chatText').value.trim();if(!text)return;$('chatText').value='';const line=document.createElement('div');line.className='chatline';line.innerHTML='<b>我</b> '+esc(text);$('chat').appendChild(line);$('chat').scrollTop=$('chat').scrollHeight;try{await api('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});setTimeout(loadChat,600)}catch(e){alert(e.message)}}
$('chatText').addEventListener('keydown',e=>{if(e.key==='Enter')$('btnChat').click()})
$('btnLocal').onclick=async()=>{const p=$('localPath').value.trim();if(!p)return;try{await api('/api/local',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});$('libHint').textContent='本机附加音频已启动'}catch(e){alert(e.message)}}
function renderTracks(title,tracks){
  $('libHint').textContent=title+' · '+tracks.length+' 首'
  $('library').innerHTML=tracks.length?tracks.map(x=>'<li><img class="thumb" src="'+img(x.cover)+'" alt=""><div class="grow"><div class="title">'+esc(x.name)+'</div><div class="mini">'+esc((x.artists||[]).join(' / '))+(x.reason?' · '+esc(x.reason):'')+'</div></div>'+pushButton(x.id)+'</li>').join(''):'<li class="mini">没有歌曲</li>'
  bindPush($('library'))
}
$('btnPlaylists').onclick=async()=>{try{const rows=await api('/api/playlists');$('libHint').textContent='我的歌单 · '+rows.length+' 个';$('library').innerHTML=rows.map(x=>'<li><img class="thumb" src="'+img(x.cover)+'" alt=""><a class="action grow" data-pid="'+x.id+'">'+esc(x.name)+'</a><span class="mini">'+x.count+' 首</span></li>').join('');$('library').querySelectorAll('a[data-pid]').forEach(a=>a.onclick=async()=>{const d=await api('/api/playlist?id='+a.dataset.pid);renderTracks(d.name,d.tracks)})}catch(e){$('libHint').textContent=e.message}}
$('btnDaily').onclick=async()=>{try{renderTracks('每日推荐',await api('/api/daily'))}catch(e){$('libHint').textContent=e.message}}
$('btnQuit').onclick=async()=>{
  if(!confirm('确定离开房间？'))return
  await api('/api/quit',{method:'POST'})
  $('chat').innerHTML=''
  $('queue').innerHTML='<li class="mini">队列为空</li>'
  $('roomLink').value='';$('roomLink').style.display='none';$('btnCopyLink').style.display='none'
  $('joinHint').textContent='已离开房间。可以加入他人的房间，或创建自己的房间。'
  refresh()
}
refresh();loadChat();loadQueue();setInterval(refresh,2000);setInterval(loadChat,3000);setInterval(loadQueue,5000)
</script>
</body>
</html>`

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  const body = async () => {
    let text = ''
    for await (const chunk of req) text += chunk
    try { return JSON.parse(text || '{}') } catch { return {} }
  }
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    if (url.pathname === '/api/status') return json(session.status())
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const data = await body()
      return json(await joinRoom(data.link))
    }
    if (req.method === 'POST' && url.pathname === '/api/create-room') {
      const result = await session.createRoom()
      return json(result)
    }
    if (url.pathname === '/api/queue') return json(await session.queue())
    if (req.method === 'GET' && url.pathname === '/api/chat') return json(await session.chatHistory())
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') ?? ''
      return json(await session.search(q))
    }
    if (url.pathname === '/api/playlists') return json(await session.playlists())
    if (url.pathname === '/api/playlist') {
      const id = Number(url.searchParams.get('id') ?? 0)
      return json(await session.playlistTracks(id))
    }
    if (url.pathname === '/api/daily') return json(await session.daily())
    if (req.method === 'POST' && url.pathname === '/api/add') {
      const data = await body()
      const result = await session.add(data.songId)
      return json({ ok: true, failedCode: result?.failedCode ?? 0 })
    }
    if (req.method === 'POST' && url.pathname === '/api/next') {
      const result = await session.next()
      return json({ ok: true, failedCode: result?.failedCode ?? 0 })
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const data = await body()
      const result = await session.cancel(data)
      return json({ ok: true, failedCode: result?.failedCode ?? 0 })
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const data = await body()
      await session.chat(data.text)
      return json({ ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') { session.pause(); return json({ ok: true }) }
    if (req.method === 'POST' && url.pathname === '/api/resume') { await session.resume(); return json({ ok: true }) }
    if (req.method === 'POST' && url.pathname === '/api/vol') {
      const data = await body()
      session.volume(data.value)
      return json({ ok: true, value: session.mpv.volume })
    }
    if (req.method === 'POST' && url.pathname === '/api/local') {
      const data = await body()
      session.playLocal(data.path)
      return json({ ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/quit') {
      await session.leave()
      return json({ ok: true })
    }
    return json({ error: 'not found' }, 404)
  } catch (error) {
    json({ error: error instanceof NeteaseError ? `${error.code}: ${error.detail || error.message}` : error.message }, 400)
  }
}

function openBrowser(url) {
  if (args.includes('--no-open')) return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const params = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, params, { stdio: 'ignore', detached: true })
    child.unref()
  } catch {}
}

function listen() {
  const server = http.createServer(handle)
  server.on('error', error => {
    if (error.code === 'EADDRINUSE' && port < 8775) {
      port += 1
      setTimeout(listen, 50)
    } else {
      console.error(error)
      process.exit(1)
    }
  })
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`
    console.log('\n========================================')
    console.log(`Web UI 地址：${url}`)
    console.log('如果浏览器没有自动打开，请手动访问这个地址。')
    console.log('========================================\n')
    openBrowser(url)
  })
}

listen()

if (rl) {
  console.log('终端命令：join <分享链接> / quit')
  for await (const raw of rl) {
    const line = String(raw).trim()
    if (!line) continue
    const [command, ...rest] = line.split(/\s+/)
    try {
      if (command === 'join') {
        await joinRoom(rest.join(' '))
      } else if (command === 'quit') {
        if (session.state.roomId) await session.leave()
        rl.close()
        process.exit(0)
      } else {
        console.log('未知命令：' + command)
      }
    } catch (error) {
      console.log('[错误] ' + error.message)
    }
  }
}

}

bootstrap().catch(error => { console.error(error); process.exit(1); })
