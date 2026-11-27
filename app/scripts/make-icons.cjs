'use strict';
/**
 * Renders build/icon.svg into the PNG sizes and the Windows .ico the desktop app uses.
 * Run with Electron (it has the browser renderer we need, no extra dependency):
 *   npx electron scripts/make-icons.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BUILD = path.resolve(__dirname, '..', 'build');
const SVG = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** One hidden page draws the SVG onto a canvas at every size (crisp, with real transparency). */
async function renderAll() {
  const win = new BrowserWindow({ width: 600, height: 600, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body></body></html>'));
  const src = 'data:image/svg+xml;base64,' + Buffer.from(SVG).toString('base64');
  const urls = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(${JSON.stringify(SIZES)}.map((n) => {
      const c = document.createElement('canvas'); c.width = n; c.height = n;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, n, n);
      return c.toDataURL('image/png');
    }));
    img.onerror = () => reject(new Error('svg did not load'));
    img.src = ${JSON.stringify(src)};
  })`);
  win.destroy();
  return urls.map((u, i) => ({ size: SIZES[i], data: Buffer.from(u.split(',')[1], 'base64') }));
}

/** An .ico is a small directory of embedded PNGs (supported since Windows Vista). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const out = await renderAll();
  for (const { size, data } of out) {
    if ([32, 256, 512].includes(size)) fs.writeFileSync(path.join(BUILD, size === 512 ? 'icon.png' : `icon-${size}.png`), data);
  }
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(out.filter((p) => p.size <= 256)));
  console.log('wrote build/icon.ico and build/icon*.png');
  app.quit();
});
