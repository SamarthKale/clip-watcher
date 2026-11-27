'use strict';
/**
 * The installed app's work folder: recordings, clips, Shorts and config.toml live here (never in the
 * install folder). Chosen on first run and remembered in Electron's user-data folder.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHOICE = 'workfolder.json';
const BUNDLED_MODEL = 'models/ggml-base.en.bin';

function readChoice(userData) {
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(userData, CHOICE), 'utf8')).dir;
    return typeof dir === 'string' && dir ? dir : null;
  } catch {
    return null;
  }
}

function saveChoice(userData, dir) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, CHOICE), JSON.stringify({ dir }, null, 2), 'utf8');
}

/** Makes the folder; writes a starter config.toml (bundled speech model) only when there is none. */
function prepare(dir, resourcesPath) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.toml');
  if (fs.existsSync(cfg)) return { created: false };
  const example = fs.readFileSync(path.join(resourcesPath, 'pipeline', 'config.example.toml'), 'utf8');
  fs.writeFileSync(cfg, example.replace(/^model\s*=.*$/m, `model = "${BUNDLED_MODEL}"`), 'utf8');
  return { created: true };
}

module.exports = { readChoice, saveChoice, prepare };
