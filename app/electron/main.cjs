'use strict';
/**
 * Clip Watcher desktop shell.
 *
 * Starts two local servers and shows them in one see-through window:
 *   - the Python pipeline API   (python -m clipwatcher ui)   recording, spikes, clips, storage
 *   - the Node app server       (app/src/server)             uploads, review, the React UI
 * The renderer is sandboxed (no Node, context isolation on) and only ever talks to the Node server.
 */
const { app, BrowserWindow, dialog, nativeTheme, screen, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
const ROOT = process.env.CLIPPER_ROOT ? path.resolve(process.env.CLIPPER_ROOT) : path.resolve(APP_DIR, '..');
const DATA_DIR = process.env.LOCALTUBE_DATA || path.join(ROOT, 'data', 'uploader');
const CONFIG = process.env.CLIPPER_CONFIG || path.join(ROOT, 'config.toml');
const PYTHON = process.env.CLIPPER_PYTHON || 'python';
const NODE = process.env.CLIPPER_NODE || 'node';

let win = null;
let pyProc = null;
let srvProc = null;
let pipeBase = '';
let srvBase = '';
let srvToken = '';
let quitting = false;
const API_TOKEN = crypto.randomBytes(24).toString('hex'); // shared by the two servers, never shown to the page
const authed = { 'x-clipper-token': API_TOKEN };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms, ok = (r) => r.ok) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { headers: authed, signal: AbortSignal.timeout(2000) });
      if (ok(r)) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

function splash(text, detail = '') {
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;
    font-family:Segoe UI,system-ui,sans-serif;color:#e4e4e7;background:rgba(10,10,18,.45);-webkit-app-region:drag">
    <div style="text-align:center"><div style="font-size:22px;font-weight:600">Clip Watcher</div>
    <div style="margin-top:10px;font-size:14px;opacity:.8">${text}</div>
    <div style="margin-top:8px;font-size:12px;opacity:.55;max-width:520px">${detail}</div></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function startPipelineApi() {
  const port = await freePort();
  pipeBase = `http://127.0.0.1:${port}`;
  pyProc = spawn(PYTHON, ['-m', 'clipwatcher', 'ui', '--no-open', '--port', String(port), '--config', CONFIG], {
    cwd: ROOT,
    env: { ...process.env, CLIPPER_API_TOKEN: API_TOKEN, PYTHONUTF8: '1', PYTHONPATH: [ROOT, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  pyProc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
  pyProc.stdout.on('data', () => {});
  pyProc.on('exit', (code) => { if (!quitting && code) console.error('pipeline API exited', code, err); });
  const up = await waitFor(`${pipeBase}/api/health`, 25_000);
  if (!up) throw new Error(`The clipping pipeline did not start.\n\nCommand: ${PYTHON} -m clipwatcher ui (in ${ROOT})\n\n${err}`);
}

async function startAppServer() {
  const paths = await (await fetch(`${pipeBase}/api/paths`, { headers: authed })).json();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const port = await freePort();
  const tsx = path.join(APP_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  srvProc = spawn(NODE, [tsx, 'src/server/index.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      LOCALTUBE_DATA: DATA_DIR,
      LOCALTUBE_NO_OPEN: '1',
      CLIPPER_LIBRARY_DIR: paths.library,
      PIPELINE_URL: pipeBase,
      PIPELINE_TOKEN: API_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  srvProc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`The app server did not start in time.\n\n${err}`)), 40_000);
    srvProc.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/LocalTube running: (http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9]+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    srvProc.on('exit', (code) => { clearTimeout(t); reject(new Error(`The app server stopped (code ${code}).\n\n${err}`)); });
  });
  srvBase = new URL(url).origin;
  srvToken = url.split('#token=')[1];
  return url;
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  // Fit the screen: a fixed size is cut off on a small or highly scaled display.
  const wa = screen.getPrimaryDisplay().workArea;
  const area = { width: wa.width, height: wa.height };
  const w = Math.min(1380, Math.round(wa.width * 0.92));
  const h = Math.min(880, Math.round(wa.height * 0.92));
  win = new BrowserWindow({
    width: w,
    height: h,
    x: wa.x + Math.round((wa.width - w) / 2),
    y: wa.y + Math.round((wa.height - h) / 2),
    minWidth: Math.min(980, area.width),
    minHeight: Math.min(640, area.height),
    show: false,
    title: 'Clip Watcher',
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic', // Windows 11: the desktop behind the window, blurred
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e4e4e7', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  // Links that leave the app (Google sign-in, YouTube) open in the normal browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('data:')) return;
    if (!srvBase || new URL(url).origin !== srvBase) {
      e.preventDefault();
      if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    void confirmQuit();
  });
  win.loadURL(splash('Starting…', 'Starting the clipping pipeline and the upload server.'));
}

async function pipelineIsRunning() {
  try {
    const s = await (await fetch(`${pipeBase}/api/state`, { headers: authed, signal: AbortSignal.timeout(3000) })).json();
    return { running: !!s.pipeline?.running, owned: !!s.pipeline?.owned };
  } catch { return { running: false, owned: false }; }
}

async function confirmQuit() {
  const p = await pipelineIsRunning();
  let stopPipeline = false;
  if (p.owned) {
    const r = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Stop watching and quit', 'Keep recording in the background', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Clip Watcher',
      message: 'The pipeline is still watching a channel.',
      detail: 'Stopping closes the recording cleanly. Keeping it running lets the stream continue to be recorded and clipped without this window.',
    });
    if (r === 2) return;
    stopPipeline = r === 0;
  }
  quitting = true;
  win.hide();
  try {
    if (stopPipeline) {
      await fetch(`${pipeBase}/api/stop`, { method: 'POST', headers: { 'content-type': 'application/json', ...authed }, body: '{}' }).catch(() => {});
      for (let i = 0; i < 60; i++) { if (!(await pipelineIsRunning()).running) break; await sleep(500); }
    }
    if (srvProc && srvBase) {
      await fetch(`${srvBase}/api/shutdown`, { method: 'POST', headers: { 'x-localtube-token': srvToken, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
      await Promise.race([new Promise((r) => srvProc.once('exit', r)), sleep(20_000)]); // uploads pause with their session saved
    }
  } finally {
    if (srvProc && srvProc.exitCode === null) srvProc.kill();
    if (pyProc && pyProc.exitCode === null) pyProc.kill();
    app.exit(0);
  }
}

async function boot() {
  Menu.setApplicationMenu(null);
  createWindow();
  try {
    await startPipelineApi();
    const url = await startAppServer();
    await win.loadURL(url);
    if (process.env.CLIPPER_PAGE) await win.webContents.executeJavaScript(`location.hash = '#/${String(process.env.CLIPPER_PAGE).replace(/[^a-z]/g, '')}'`);
    if (process.env.CLIPPER_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  } catch (e) {
    if (win && !win.isDestroyed()) {
      await win.loadURL(splash('Clip Watcher could not start', String(e.message || e).replace(/[<>&]/g, ' ')));
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
