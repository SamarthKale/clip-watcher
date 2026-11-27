'use strict';
/**
 * The installed app's work folder: recordings, clips, Shorts and config.toml live here (never in the
 * install folder). Chosen on first run and remembered in Electron's user-data folder.
 */
const fs = require('node:fs');
const path = require('node:path');

const CHOICE = 'workfolder.json';
// Multilingual: Hindi, English, Hinglish and others are detected per clip.
const BUNDLED_MODEL = 'models/ggml-large-v3-turbo-q5_0.bin';
// What Spikecut 1.0 wrote into new work folders (English only; that model no longer ships).
const OLD_MODEL_LINE = 'model = "models/ggml-base.en.bin"';

/** Applies fn to the text of the [transcribe] table only. */
function inTranscribe(text, fn) {
  const m = /^\[transcribe\][^\n]*\n/m.exec(text);
  if (!m) return text;
  const start = m.index + m[0].length;
  const next = text.slice(start).search(/^\[/m);
  const end = next === -1 ? text.length : start + next;
  return text.slice(0, start) + fn(text.slice(start, end)) + text.slice(end);
}

function speechLines(text) {
  return inTranscribe(text, (t) => t.replace(/^model\s*=.*$/m, `model = "${BUNDLED_MODEL}"`).replace(/^language\s*=.*$/m, 'language = "auto"'));
}

/**
 * A work folder made by Spikecut 1.0 names the English-only model it shipped. Upgrade exactly those
 * lines (model + its language) once; a model the owner picked is never touched. Returns true if changed.
 */
function upgrade(dir) {
  const cfg = path.join(dir, 'config.toml');
  let text;
  try { text = fs.readFileSync(cfg, 'utf8'); } catch { return false; }
  let hit = false;
  const next = inTranscribe(text, (t) => {
    if (!t.split(/\r?\n/).some((l) => l.trim() === OLD_MODEL_LINE)) return t;
    hit = true;
    return t.replace(/^model\s*=.*$/m, `model = "${BUNDLED_MODEL}"`).replace(/^language\s*=\s*"en"\s*$/m, 'language = "auto"');
  });
  if (!hit) return false;
  fs.writeFileSync(cfg, next, 'utf8');
  return true;
}

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
  fs.writeFileSync(cfg, speechLines(example), 'utf8');
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
    if (!prepare(dir, resourcesPath).created) upgrade(dir);
  } catch (e) {
    throw new Error(`Spikecut can't use the folder ${dir}: ${e.message}`);
  }
  if (!override && !remembered) saveChoice(userData, dir);
  return dir;
}

module.exports = { readChoice, saveChoice, prepare, upgrade, forget, setUp };
