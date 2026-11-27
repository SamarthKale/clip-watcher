@echo off
rem Opens the Clip Watcher desktop app (glass window). Needs Node 20+ and Python 3.11+ on PATH.
cd /d "%~dp0app"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing the app for the first time...
  call npm ci
  node node_modules\electron\install.js
)
if not exist "dist\ui\index.html" call npm run build:ui
start "" "node_modules\electron\dist\electron.exe" .
