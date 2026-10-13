@echo off
chcp 65001 >nul
title 周周记 - 本机离线 OCR 服务
cd /d "%~dp0"

echo ============================================================
echo   周周记 - 本机离线 OCR 服务
echo   使用 Windows 系统自带 OCR 引擎，图片不上传、不联网
echo ============================================================
echo.

REM 优先使用项目内置的托管 Python
set "PY="
if exist "%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe" (
  set "PY=%USERPROFILE%\.workbuddy-ai\binaries\python\versions\3.13.12\python.exe"
)
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  where py >nul 2>nul && set "PY=py"
)
if not defined PY (
  echo [错误] 未找到 Python，请先安装 Python 3.10 以上版本。
  echo        下载地址： https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo 使用 Python: %PY%
echo.

REM 检查 winrt 运行库，缺失则自动安装
"%PY%" -c "import winrt.windows.media.ocr, winrt.windows.foundation.collections" >nul 2>nul
if errorlevel 1 (
  echo [1/2] 首次运行，正在安装 OCR 运行库 winrt（约 15MB）...
  "%PY%" -m pip install --quiet --disable-pip-version-check ^
    winrt-runtime winrt-Windows.Foundation winrt-Windows.Foundation.Collections ^
    winrt-Windows.Media.Ocr winrt-Windows.Globalization ^
    winrt-Windows.Graphics.Imaging winrt-Windows.Storage.Streams
  if errorlevel 1 (
    echo.
    echo [错误] 安装失败。请手动执行：
    echo    "%PY%" -m pip install winrt-runtime winrt-Windows.Foundation winrt-Windows.Foundation.Collections winrt-Windows.Media.Ocr winrt-Windows.Globalization winrt-Windows.Graphics.Imaging winrt-Windows.Storage.Streams
    echo.
    pause
    exit /b 1
  )
  echo       安装完成。
) else (
  echo [1/2] OCR 运行库已就绪。
)

echo [2/2] 正在启动服务...
echo.
"%PY%" "%~dp0ocr_server.py"

echo.
echo 服务已停止。
pause
