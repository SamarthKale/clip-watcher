@echo off
rem Opens the Spikecut desktop app. Needs Node 20+ and Python 3.11+ on PATH.
cd /d "%~dp0app"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing the app for the first time...
  call npm ci
  node node_modules\electron\install.js
)
rem Rebuild the interface when the code changed since the last build (for example after an update).
set "HEAD="
set "BUILT="
for /f %%h in ('git rev-parse HEAD 2^>nul') do set "HEAD=%%h"
if exist "dist\ui\.built-from" set /p BUILT=<"dist\ui\.built-from"
if not exist "dist\ui\index.html" goto build
if not "%HEAD%"=="%BUILT%" goto build
goto run
:build
echo Preparing Spikecut...
call npm run build:ui
if defined HEAD >"dist\ui\.built-from" echo %HEAD%
:run
start "" "node_modules\electron\dist\electron.exe" .
