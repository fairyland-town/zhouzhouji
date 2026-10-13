@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 周周记 - 本地服务器
cd /d "%~dp0.."

set "PORT=8080"
set "URL=http://localhost:%PORT%"

echo ============================================================
echo   周周记 - 本地预览服务器
echo ============================================================
echo.

REM ---------- 1. 如果端口已被占用，直接打开浏览器即可 ----------
netstat -ano 2>nul | findstr /r /c:"LISTENING" | findstr /c:":%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 已在运行，无需重复启动。
  echo        正在为你打开浏览器...
  start "" "%URL%"
  echo.
  echo        如果打开的页面不对，说明该端口被其他程序占用，
  echo        请关闭本窗口后改用 tools\serve.mjs 指定其他端口。
  echo.
  pause
  exit /b 0
)

REM ---------- 2. 找到 Python ----------
set "PY="
if exist "%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe" (
  set "PY=%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"
)
if not defined PY (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PY set "PY=%%i"
  )
)
if not defined PY (
  for /f "delims=" %%i in ('where py 2^>nul') do (
    if not defined PY set "PY=%%i"
  )
)

REM ---------- 3. 找到 Node ----------
set "NODE="
if exist "%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe" (
  set "NODE=%USERPROFILE%\.workbuddy-ai\binaries\node\versions\22.22.2-2\node.exe"
)
if not defined NODE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%i"
  )
)

REM ---------- 4. 启动服务器 ----------
if defined PY (
  echo 使用 Python 启动: !PY!
  echo 地址: %URL%
  echo 按 Ctrl+C 停止
  echo ------------------------------------------------------------
  start "" "%URL%"
  "!PY!" -m http.server %PORT% --directory web
  goto :done
)

if defined NODE (
  echo 使用 Node 启动: !NODE!
  echo 地址: %URL%
  echo 按 Ctrl+C 停止
  echo ------------------------------------------------------------
  start "" "%URL%"
  "!NODE!" tools\serve.mjs %PORT%
  goto :done
)

echo [错误] 未找到 Python 或 Node，无法启动本地服务器。
echo.
echo        替代方案：直接双击 web\index.html
echo        若页面空白，说明你的浏览器限制了本地模块加载，
echo        请安装 Python（https://www.python.org/downloads/）后重试。
echo.
pause
exit /b 1

:done
echo.
echo 服务已停止。若浏览器页面还在，刷新后可能显示不出来，属正常现象。
pause
