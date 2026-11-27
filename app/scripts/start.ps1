# Starts LocalTube: checks prerequisites, installs dependencies on first run, builds the UI and opens the app.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Require($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Write-Host "Missing: $name. $hint" -ForegroundColor Red
    exit 1
  }
}
Require node   'Install Node.js 20 or newer from https://nodejs.org'
Require ffmpeg 'Install FFmpeg (for example: winget install Gyan.FFmpeg) and reopen this window, or set FFMPEG_PATH and FFPROBE_PATH.'
Require ffprobe 'FFprobe comes with FFmpeg and must be on PATH.'

if (-not (Test-Path node_modules)) { npm install }
npm start
