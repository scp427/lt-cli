# lt-cli

`lt-cli` 是一个本地命令行工具与 Web 控制台，用于加入网易云音乐「一起听」房间，并用本机 `mpv` 播放与房间同步的音频。

项目支持两种房间模式：

- **多人房间**：加入他人分享的房间，跟随房间播放进度。
- **自建房间**：创建官方 host 模式房间，管理歌单、推歌、切歌并生成分享链接。

## 功能

- 命令行与本地 Web UI 两种操作方式
- 扫码登录；macOS 可选从网易云桌面客户端导入 Cookie
- 加入多人房间或创建自己的房间
- 使用 `mpv` 播放，按房间状态自动对齐进度
- 查看成员、当前歌曲、待播队列和房间聊天
- 搜索歌曲、查看歌单与每日推荐，并推入房间队列
- 自建房间支持推歌、取消、下一首和官方分享链接
- 本机附加播放本地音频文件
- 单文件启动器，可脱离源码目录运行

## 环境要求

- Node.js **≥ 22.5**
- `mpv`，并已加入 `PATH`
- 网易云音乐账号

可选：

- Python 3：仅在 macOS 上从桌面客户端导入 Cookie 时需要
- esbuild：仅在重新构建单文件启动器时需要，运行时不需要

## 下载打包版

可直接在 GitHub Releases 下载自包含启动器：

| 平台 | 下载 |
| --- | --- |
| macOS / Linux | [lt-ui-macos-linux.zip](https://github.com/scp427/lt-cli/releases/download/v0.1.1/lt-ui-macos-linux.zip) |
| Windows | [lt-ui-windows.zip](https://github.com/scp427/lt-cli/releases/download/v0.1.1/lt-ui-windows.zip) |

也可直接下载单个文件：

- [lt-ui](https://github.com/scp427/lt-cli/releases/download/v0.1.1/lt-ui)
- [lt-ui.cmd](https://github.com/scp427/lt-cli/releases/download/v0.1.1/lt-ui.cmd)

解压后直接运行即可。目标机器仍需具备 Node.js ≥ 22.5 与 mpv。

## 快速开始

### 源码运行

```bash
# 启动 Web UI
node ui.mjs

# 启动命令行
node cli.mjs

# 直接携带分享链接启动
node cli.mjs '<分享链接>'
node ui.mjs '<分享链接>'
```

首次运行时如果本机没有有效登录态，会打开二维码页面。扫码完成后 Cookie 会保存到用户目录下的 `~/.lt-cli/account.json`，文件权限为 `0600`。

在 macOS 上也可以先尝试从桌面客户端导入登录态：

```bash
python3 tools/import_cookie.py
```

### 常用参数

```text
--port=8765    指定 Web UI 端口
--no-open      启动后不自动打开浏览器
--login        强制重新扫码登录
--deps-check-only
               只检查依赖，不启动服务
```

## 命令行

进入交互模式后输入 `help` 查看全部命令：

```text
create            创建房间并输出分享链接
status            查看房间、当前歌曲与同步状态
queue             查看待播队列
add [关键词|ID]    搜索并推歌到共同队列
lsearch <关键词>   搜索桌面客户端缓存的本地歌单
playlists         查看我的歌单
daily             查看每日推荐
play <歌单ID>      列出歌单歌曲
next              请求下一首
chat <文字>        发送房间消息
local <文件路径>   本机额外播放一个音频文件
pause / resume    本机暂停 / 恢复
vol <0-100>       本机音量
quit              离开房间并退出
```

## Web UI

启动后访问：

```text
http://127.0.0.1:8765/
```

Web UI 提供：

- 房间链接显示与复制
- 当前歌曲、封面、进度与成员列表
- 待播队列与搜索推歌
- 房间聊天
- 暂停、恢复对齐、下一首、音量控制
- 我的歌单、每日推荐
- 本机附加音频播放
- 创建房间与离开房间

## 房间模式

### 加入多人房间

分享链接格式：

```text
https://st.music.163.com/listen-together/multishare/index.html?roomId=...&inviterUid=...
```

本项目解析 `roomId` 与 `inviterUid`，通过多人房间协议完成预览、加入、心跳、状态同步与操作。

### 创建自建房间

创建后 Web UI 会显示两种链接：

```text
https://st.music.163.com/listen-together/share/?songId=...&roomId=...&inviterId=...
```

```text
https://st.music.163.com/listen-together/multishare/index.html?roomId=...&inviterUid=...&isFLT=false
```

第一种是官方 App 房间链接；第二种保留给本项目及 multishare 流程使用。

如果账号已在房间中，创建接口会返回现有房间，不会重复建房。

### 自动接管已有房间

启动 CLI 或 Web UI 时，如果未传入分享链接，程序会检测当前账号是否已经处于官方 App 创建的房间中：

- 多人匹配房间：通过 `multi/match/status/get` 检测
- 自建 host 房间：通过 `listen/together/status/get` 检测

检测到后会自动接管该房间，无需再次粘贴链接。若启动时未检测到房间，程序会继续以 4 秒间隔检测，因此先启动程序、后在 App 中创建房间也能自动接管。若官方 App 中取消或退出房间，本地状态会在下一次状态轮询中同步为已离开，并停止播放与心跳。

## 同步方式

### 多人房间

- 加入：`listen/together/multi/match/ack`
- 心跳与状态：`multi/match/heartbeat`、`multi/match/status/get`
- 歌曲与进度：从房间快照读取当前歌曲、播放时间、时长和版本
- 音源：通过 `mpv --start` 与 IPC seek 对齐进度
- 推歌、下一首、删除：`multi/match/song/operate`

进度按房间状态同步；歌曲变化时会自动起播新歌，偏差较大时会重新 seek。

### 自建房间

- 房间状态：`listen/together/status/get`
- 歌单：`listen/together/sync/playlist/get`
- 推歌与取消：`listen/together/sync/list/command/report`
- 切歌与播放控制：`listen/together/play/command/report`
- 心跳：`listen/together/heartbeat`
- 结束房间：`listen/together/end/v2`

自建房间中本项目作为房主，负责歌单、播放命令和房间生命周期。

## 当前限制

- 使用网易云私有接口，可能随官方客户端更新而失效。
- 版权、地区或试听限制可能导致部分歌曲拿不到音源。
- 多人房间中「暂停 / 恢复」仅作用于本机，不改变房间播放状态。
- 自建房间聊天历史依赖本地消息缓存；服务端没有对应的公开历史接口。
- 待播队列暂不支持调整已有歌曲顺序。
- 多人房间与自建房间使用不同协议，本项目不能保证以同一流程互相加入。
- 官方 App 不会自动打开本项目创建的房间；需要在 App 中打开官方分享链接或刷新 App 状态。
- Cookie 等同账号凭据，请不要分享给他人。

## 自包含启动器

Node.js 与 mpv 不作为打包内容；其余项目代码会内嵌进单个启动器文件。

构建：

```bash
npm install --no-save esbuild
npm run build
```

产物：

```text
dist/lt-ui        macOS / Linux
dist/lt-ui.cmd    Windows
```

构建完成后可删除 `node_modules`，产物运行时不需要它。每个启动器约 190 KB，可直接复制到目标机器运行，只需目标机器具备 Node.js ≥ 22.5 与 mpv。

启动示例：

```bash
./lt-ui
./lt-ui '<分享链接>'
```

启动器会先检查依赖，再解压内嵌代码到临时目录执行，并在退出时清理。

## 项目结构

```text
cli.mjs                命令行入口
ui.mjs                 本地 Web UI 入口
build.mjs              自包含启动器构建脚本
lib/
  auth.mjs             登录态与二维码登录
  deps.mjs             依赖检查
  local-library.mjs    本地歌曲缓存索引
  mpv.mjs              mpv 播放控制
  netease.mjs          网易云接口封装
  session.mjs          房间状态与同步逻辑
tools/
  import_cookie.py     macOS 桌面客户端 Cookie 导入
vendor/
  qrcode.mjs           二维码生成
```

## 许可证与致谢

- `lib/netease.mjs` 与 `vendor/qrcode.mjs` 参考 MIT 项目 [WEATER604/dsh-listen-together](https://github.com/WEATER604/dsh-listen-together)，许可证见 `LICENSE.dsh-listen-together`。
- 多人队列、推歌与音源协议参考 [tabidachinokaze/music-party](https://github.com/tabidachinokaze/music-party) 的协议文档 。
