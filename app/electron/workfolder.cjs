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

function forget(userData) {
  fs.rmSync(path.join(userData, CHOICE), { force: true });
}

/**
 * The work folder for this launch: the override (SPIKECUT_WORK_DIR), else the remembered choice, else
 * ask(). It is remembered only once it has been prepared, so a folder that can't be used is asked
 * about again next time. Throws "Spikecut can't use the folder ..." when it can't be prepared.
 */
function setUp({ userData, override, resourcesPath, ask }) {
  const remembered = override ? null : readChoice(userData);
  const dir = override || remembered || ask();
  try {
    prepare(dir, resourcesPath);
  } catch (e) {
    throw new Error(`Spikecut can't use the folder ${dir}: ${e.message}`);
  }
  if (!override && !remembered) saveChoice(userData, dir);
  return dir;
}

module.exports = { readChoice, saveChoice, prepare, forget, setUp };
