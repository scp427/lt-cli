import { spawnSync } from 'node:child_process'

function which(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8', timeout: 5000,
  })
  return result.status === 0 && Boolean(result.stdout?.trim())
}

export async function checkDependencies() {
  const items = []

  const [major, minor, patch] = process.versions.node.split('.').map(Number)
  const nodeOk = major > 22 || (major === 22 && minor >= 5)
  items.push({
    name: 'Node.js',
    ok: nodeOk,
    found: process.versions.node,
    required: '>= 22.5.0',
    hint: '请安装 Node.js 22.5 或更高版本（node:sqlite 需要）：https://nodejs.org/',
    install: process.platform === 'darwin' ? 'brew install node' : '',
  })

  const mpvOk = which('mpv')
  items.push({
    name: 'mpv',
    ok: mpvOk,
    found: mpvOk ? '已在 PATH 中找到' : '未找到',
    required: '任意现代版本',
    hint: process.platform === 'darwin'
      ? '安装：brew install mpv'
      : process.platform === 'win32'
        ? '下载 mpv.exe 并加入 PATH：https://mpv.io/installation/'
        : '安装：sudo apt install mpv（或对应发行版包管理器）',
    install: process.platform === 'darwin' ? 'brew install mpv' : '',
  })

  let sqliteOk = true
  let sqliteFound = 'node:sqlite 可用'
  try {
    await import('node:sqlite')
  } catch (error) {
    sqliteOk = false
    sqliteFound = '不可用'
  }
  items.push({
    name: 'node:sqlite',
    ok: sqliteOk,
    found: sqliteFound,
    required: 'Node 22+ 内建',
    hint: '升级到 Node.js 22+；本地歌单索引依赖此模块',
  })

  return {
    ok: items.every(item => item.ok),
    items,
  }
}

export function installDependency(command) {
  const result = spawnSync(command, { shell: true, stdio: 'inherit', timeout: 600000 })
  return result.status === 0
}

export function formatDependencies(report) {
  const lines = ['依赖检查：']
  for (const item of report.items) {
    lines.push(`  ${item.ok ? '✓' : '✗'} ${item.name}: ${item.found}（需要 ${item.required}）`)
    if (!item.ok) lines.push(`      ${item.hint}`)
  }
  return lines.join('\n')
}
