'use strict';
/**
 * Spikecut desktop shell.
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

const { resolveRuntime } = require('./runtime.cjs');
const workfolder = require('./workfolder.cjs');

// From the repo this is app/; installed it is resources/app.asar (the bundled main lives in dist/electron).
const APP_DIR = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
let RT = null; // resolveRuntime(): which Python, server, folders and environment to use

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

const ICON = path.join(APP_DIR, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const LOGO_SVG = (() => {
  try { return fs.readFileSync(path.join(APP_DIR, 'build', 'icon.svg'), 'utf8'); } catch { return ''; }
})();

/** The start screen: the Spikecut mark draws its spike line, then the status underneath. */
function splash(text, detail = '', failed = false) {
  // The line draws itself; the cut and the coral dot land after it.
  const mark = LOGO_SVG
    .replace(/width="512" height="512"/, 'width="84" height="84"')
    .replace('<path ', '<path pathLength="1" class="line" ')
    .replace('<circle ', '<circle class="dot" ');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;height:100vh;display:grid;place-items:center;font-family:'Segoe UI Variable Display','Segoe UI',system-ui,sans-serif;
      color:#26241f;background:rgba(247,245,240,.9);-webkit-app-region:drag}
    .wrap{text-align:center;animation:up .5s cubic-bezier(.16,1,.3,1) both}
    .mark{filter:drop-shadow(0 6px 14px rgba(40,36,30,.12))}
    .line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw .9s .15s cubic-bezier(.65,0,.35,1) forwards}
    .dot{transform-origin:50.5px 14px;transform:scale(0);animation:pop .45s 1s cubic-bezier(.34,1.56,.64,1) forwards}
    .name{margin-top:18px;font-size:26px;font-weight:600;letter-spacing:-.02em}.name b{color:#7a6dad;font-weight:600}
    .tag{margin-top:4px;font-size:13px;color:#7c776d}
    .text{margin-top:26px;font-size:14px;color:${failed ? '#9a5252' : '#4a463e'}}
    .detail{margin:8px auto 0;font-size:12px;color:#7c776d;max-width:560px;white-space:pre-wrap;-webkit-app-region:no-drag;user-select:text}
    .bar{margin:18px auto 0;width:160px;height:3px;border-radius:3px;background:rgba(40,36,30,.08);overflow:hidden}
    .bar i{display:block;height:100%;width:40%;border-radius:3px;background:#a99cd2;animation:slide 1.2s ease-in-out infinite}
    @keyframes draw{to{stroke-dashoffset:0}}@keyframes pop{to{transform:scale(1)}}
    @keyframes up{from{opacity:0;transform:translateY(10px)}}@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important}.line{stroke-dashoffset:0}.dot{transform:none}}
    </style><body><div class="wrap"><div class="mark">${mark}</div>
    <div class="name">Spike<b>cut</b></div><div class="tag">Catch the spike. Cut the Short.</div>
    <div class="text">${text}</div>${failed ? '' : '<div class="bar"><i></i></div>'}<div class="detail">${detail}</div></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

async function startPipelineApi() {
  const port = await freePort();
  pipeBase = `http://127.0.0.1:${port}`;
  pyProc = spawn(RT.python, ['-m', 'clipwatcher', 'ui', '--no-open', '--port', String(port), '--config', RT.config], {
    cwd: RT.root,
    env: { ...RT.childEnv, CLIPPER_API_TOKEN: API_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  pyProc.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
  pyProc.stdout.on('data', () => {});
  pyProc.on('exit', (code) => { if (!quitting && code) console.error('pipeline API exited', code, err); });
  const up = await waitFor(`${pipeBase}/api/health`, 25_000);
  if (!up) throw new Error(`The clipping pipeline did not start.\n\nCommand: ${RT.python} -m clipwatcher ui (in ${RT.root})\n\n${err}`);
}

async function startAppServer() {
  const paths = await (await fetch(`${pipeBase}/api/paths`, { headers: authed })).json();
  fs.mkdirSync(RT.dataDir, { recursive: true });
  const port = await freePort();
  srvProc = spawn(RT.server.cmd, RT.server.args, {
    cwd: RT.server.cwd,
    env: {
      ...RT.server.env,
      PORT: String(port),
      LOCALTUBE_DATA: RT.dataDir,
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
  nativeTheme.themeSource = 'light'; // the light acrylic tint that matches the Spikecut look
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
    title: 'Spikecut',
    icon: ICON,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic', // Windows 11: the desktop behind the window, blurred
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#3f3f46', height: 36 },
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
  win.loadURL(splash('Getting things ready…', 'Starting the clipping pipeline and the upload server.'));
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
      title: 'Spikecut',
      message: 'Spikecut is still watching a channel.',
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

/** Installed app: the folder for recordings, clips and Shorts (asked once, then remembered). */
function chooseWorkDir() {
  const userData = app.getPath('userData');
  let dir = process.env.SPIKECUT_WORK_DIR || workfolder.readChoice(userData);
  if (!dir) {
    const suggested = path.join(app.getPath('documents'), 'Spikecut');
    const r = dialog.showMessageBoxSync({
      type: 'question',
      buttons: [`Use ${suggested}`, 'Choose a folder…'],
      defaultId: 0,
      cancelId: 0,
      title: 'Spikecut',
      message: 'Where should Spikecut keep recordings, clips and Shorts?',
      detail: 'Recordings are large, so pick a drive with plenty of free space. If you have used Spikecut before, choose that folder to keep your work.',
    });
    dir = suggested;
    if (r === 1) {
      const picked = dialog.showOpenDialogSync({ title: 'Spikecut work folder', defaultPath: suggested, properties: ['openDirectory', 'createDirectory'] });
      if (picked && picked[0]) dir = picked[0];
    }
    workfolder.saveChoice(userData, dir);
  }
  workfolder.prepare(dir, process.resourcesPath);
  return dir;
}

async function boot() {
  Menu.setApplicationMenu(null);
  const workDir = app.isPackaged ? chooseWorkDir() : undefined;
  RT = resolveRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: APP_DIR,
    execPath: process.execPath,
    env: process.env,
    home: app.getPath('home'),
    workDir,
  });
  createWindow();
  try {
    await startPipelineApi();
    const url = await startAppServer();
    await win.loadURL(url);
    if (process.env.CLIPPER_PAGE) await win.webContents.executeJavaScript(`location.hash = '#/${String(process.env.CLIPPER_PAGE).replace(/[^a-z]/g, '')}'`);
    if (process.env.CLIPPER_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  } catch (e) {
    if (win && !win.isDestroyed()) {
      await win.loadURL(splash('Spikecut could not start', String(e.message || e).replace(/[<>&]/g, ' '), true));
    }
  }
}

// The app was renamed to Spikecut; its browser data (remembered channel, window state) stays in the
// folder it always used, so nothing is lost by the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Clip Watcher'));
app.setAppUserModelId('app.spikecut.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(boot);
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
}
