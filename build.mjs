#!/usr/bin/env node
// 生成自包含启动器：内嵌全部项目代码；Node.js 与 mpv 仍从运行环境读取。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let esbuild
try {
  esbuild = await import('esbuild')
} catch {
  console.error('构建需要 esbuild，请先运行：npm install --no-save esbuild')
  process.exit(1)
}

const root = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(root, 'dist')
fs.mkdirSync(dist, { recursive: true })

const built = await esbuild.build({
  entryPoints: [path.join(root, 'ui.mjs')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'silent',
})
const js = built.outputFiles[0].text
const py = fs.readFileSync(path.join(root, 'tools', 'import_cookie.py'), 'utf8')
const jsB64 = Buffer.from(js).toString('base64')
const pyB64 = Buffer.from(py).toString('base64')

const unix = `#!/usr/bin/env bash
set -u
TMPROOT=/tmp
if [ -n "\${TMPDIR:-}" ]; then TMPROOT="$TMPDIR"; fi
WORK="$TMPROOT/lt-ui-$$"
mkdir -p "$WORK/tools"

JS_B64=$(cat <<'LT_JS_B64'
__JS_B64__
LT_JS_B64
)
PY_B64=$(cat <<'LT_PY_B64'
__PY_B64__
LT_PY_B64
)
printf '%s' "$JS_B64" | base64 -d > "$WORK/ui.mjs"
printf '%s' "$PY_B64" | base64 -d > "$WORK/tools/import_cookie.py"
export LT_IMPORT_COOKIE_SCRIPT="$WORK/tools/import_cookie.py"

echo "依赖检查："
MISSING=""
NODE_OK=1
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -p "process.versions.node" 2>/dev/null || echo 0)"
  NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
  if [ "$NODE_MAJOR" -gt 22 ] 2>/dev/null || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; } 2>/dev/null; then
    echo "  ✓ Node.js: $NODE_VER（需要 >= 22.5）"
  else
    echo "  ✗ Node.js: $NODE_VER（需要 >= 22.5）"
    NODE_OK=0; MISSING="$MISSING node"
  fi
else
  echo "  ✗ Node.js: 未找到（需要 >= 22.5）"
  NODE_OK=0; MISSING="$MISSING node"
fi
MPV_OK=1
if command -v mpv >/dev/null 2>&1; then
  echo "  ✓ mpv: 已在 PATH 中找到"
else
  echo "  ✗ mpv: 未找到"
  MPV_OK=0; MISSING="$MISSING mpv"
fi
if [ -n "$MISSING" ]; then
  if [ -t 0 ]; then
    ANSWER=""
    read -r -p "是否尝试自动安装缺失依赖（$MISSING）？[y/N] " ANSWER || true
    if [[ "$ANSWER" =~ ^[Yy] ]]; then
      if command -v brew >/dev/null 2>&1; then brew install $MISSING
      else
        echo "未找到 Homebrew，请手动安装：$MISSING" >&2
        echo "  Node.js: https://nodejs.org/" >&2
        echo "  mpv: brew install mpv 或 https://mpv.io/installation/" >&2
      fi
    fi
  else
    echo "非交互环境无法询问，请手动安装：$MISSING" >&2
  fi
  NODE_OK=1; MPV_OK=1
  if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -p "process.versions.node" 2>/dev/null || echo 0)"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
    { [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; } 2>/dev/null || NODE_OK=0
  else NODE_OK=0; fi
  command -v mpv >/dev/null 2>&1 || MPV_OK=0
fi
if [ "$NODE_OK" -ne 1 ] || [ "$MPV_OK" -ne 1 ]; then
  echo "依赖未满足，启动中止。" >&2
  rm -rf "$WORK"
  exit 1
fi
node "$WORK/ui.mjs" "$@"
STATUS=$?
rm -rf "$WORK"
exit $STATUS
`.replace('__JS_B64__', jsB64).replace('__PY_B64__', pyB64)

const win = `@echo off
setlocal EnableDelayedExpansion
set "WORK=%TEMP%\\lt-ui-%RANDOM%%RANDOM%"
mkdir "%WORK%\\tools" >nul 2>nul
set "LT_SELF=%~f0"
set "LT_JS=%WORK%\\ui.mjs"
set "LT_PY=%WORK%\\tools\\import_cookie.py"
set "LT_IMPORT_COOKIE_SCRIPT=%LT_PY%"
powershell -NoProfile -Command "$t=[IO.File]::ReadAllText($env:LT_SELF); $b=[string]::Concat('__','LT_JS_BEGIN__'); $e=[string]::Concat('__','LT_JS_END__'); $i=$t.IndexOf($b); $j=$t.IndexOf($e,$i+$b.Length); $v=$t.Substring($i+$b.Length,$j-$i-$b.Length).Trim(); [IO.File]::WriteAllBytes($env:LT_JS,[Convert]::FromBase64String($v)); $b=[string]::Concat('__','LT_PY_BEGIN__'); $e=[string]::Concat('__','LT_PY_END__'); $i=$t.IndexOf($b); $j=$t.IndexOf($e,$i+$b.Length); $v=$t.Substring($i+$b.Length,$j-$i-$b.Length).Trim(); [IO.File]::WriteAllBytes($env:LT_PY,[Convert]::FromBase64String($v));"
if not exist "%LT_JS%" (
  echo   [X] Failed to extract embedded source.
  call :cleanup
  exit /b 1
)

echo Dependency check:
call :check_node
call :check_mpv
if "!NODE_OK!!MPV_OK!"=="11" goto run

set "ANSWER="
set /p "ANSWER=Install missing dependencies with winget? [y/N]: "
if /I "!ANSWER!"=="y" (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo   [X] winget not found. Install manually:
    echo       Node.js: https://nodejs.org/
    echo       mpv: https://mpv.io/installation/
  ) else (
    if "!NODE_OK!"=="0" winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if "!MPV_OK!"=="0" winget install --id mpv.mpv -e --accept-source-agreements --accept-package-agreements
    call :refresh_path
    call :check_node
    call :check_mpv
  )
)
if not "!NODE_OK!!MPV_OK!"=="11" (
  echo Dependency not satisfied. Restart the terminal and try again.
  call :cleanup
  exit /b 1
)

:run
node "%LT_JS%" %*
set STATUS=!ERRORLEVEL!
call :cleanup
exit /b !STATUS!

:check_node
set NODE_OK=1
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found. Need ^>= 22.5.
  set NODE_OK=0
  goto :eof
)
set NODE_MAJOR=0
set NODE_MINOR=0
for /f "tokens=1,2 delims=." %%a in ('node -p "process.versions.node" 2^>nul') do (
  set NODE_MAJOR=%%a
  set NODE_MINOR=%%b
)
if !NODE_MAJOR! LSS 22 (
  echo   [X] Node.js too old. Need ^>= 22.5.
  set NODE_OK=0
  goto :eof
)
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! LSS 5 (
  echo   [X] Node.js too old. Need ^>= 22.5.
  set NODE_OK=0
  goto :eof
)
echo   [OK] Node.js found: >= 22.5.
goto :eof

:check_mpv
set MPV_OK=1
where mpv >nul 2>nul
if errorlevel 1 (
  echo   [X] mpv not found. Need mpv.exe in PATH.
  set MPV_OK=0
  goto :eof
)
echo   [OK] mpv found.
goto :eof

:refresh_path
for /f "tokens=2*" %%A in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
set "PATH=!SYS_PATH!;!USER_PATH!;!PATH!"
goto :eof

:cleanup
rmdir /S /Q "%WORK%" >nul 2>nul
goto :eof

__LT_JS_BEGIN__
__JS_B64__
__LT_JS_END__
__LT_PY_BEGIN__
__PY_B64__
__LT_PY_END__
`.replace('__JS_B64__', jsB64).replace('__PY_B64__', pyB64)

const unixPath = path.join(dist, 'lt-ui')
const winPath = path.join(dist, 'lt-ui.cmd')
fs.writeFileSync(unixPath, unix, { mode: 0o755 })
fs.writeFileSync(winPath, win.replace(/\n/g, '\r\n'))
console.log(`生成完成：\n  ${unixPath} (${(Buffer.byteLength(unix) / 1024).toFixed(0)} KB)\n  ${winPath} (${(Buffer.byteLength(win) / 1024).toFixed(0)} KB)`)
console.log('已内嵌全部项目代码；只依赖目标机器的 Node.js 与 mpv。')
