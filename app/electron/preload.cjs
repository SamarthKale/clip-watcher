'use strict';
// The renderer is sandboxed with no Node access. The only thing it learns from here is that it
// is inside the desktop app (so the page switches to the glass theme).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('clipper', Object.freeze({ isDesktop: true, platform: process.platform }));
