import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { resolveRuntime } = require('../../electron/runtime.cjs');
const workfolder = require('../../electron/workfolder.cjs');

const RES = 'C:\\Users\\Sam Kale\\AppData\\Local\\Programs\\Spikecut\\resources';
const APP = RES + '\\app.asar';
const HOME = 'C:\\Users\\Sam Kale';
const WORK = 'C:\\Users\\Sam Kale\\Documents\\Spikecut';
const pathOf = (env: Record<string, string>) => {
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  expect(keys).toHaveLength(1); // exactly one PATH variable, whatever its case
  return env[keys[0]].split(';');
};

describe('installed app runtime', () => {
  const packaged = () =>
    resolveRuntime({
      isPackaged: true,
      resourcesPath: RES,
      appDir: APP,
      env: { Path: 'C:\\Windows\\system32', PYTHONHOME: 'C:\\Python313', PYTHONPATH: 'C:\\mine', USERPROFILE: HOME },
      home: HOME,
      workDir: WORK,
    });

  it('puts the bundled Python and tools, then Claude Code, before the system PATH', () => {
    const p = pathOf(packaged().childEnv);
    expect(p.slice(0, 6)).toEqual([
      RES + '\\python',
      RES + '\\tools\\ffmpeg',
      RES + '\\tools\\whisper',
      RES + '\\tools\\yt-dlp',
      HOME + '\\.local\\bin', // Claude Code installed while Spikecut is open is still found
      'C:\\Windows\\system32',
    ]);
  });

  it("ignores the user's own Python settings and never writes bytecode into the install", () => {
    const env = packaged().childEnv;
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PYTHONPATH).toBeUndefined();
    expect(env.PYTHONDONTWRITEBYTECODE).toBe('1');
    expect(env.PYTHONUTF8).toBe('1');
    expect(env.CLIPPER_RESOURCES).toBe(RES);
  });

  it('runs the bundled pipeline, and the bundled server with the bundled Node', () => {
    const rt = packaged();
    expect(rt.root).toBe(WORK);
    expect(rt.config).toBe(WORK + '\\config.toml');
    expect(rt.dataDir).toBe(WORK + '\\data\\uploader');
    expect(rt.python).toBe(RES + '\\python\\python.exe');
    // its own Node: the database module's ready-made build matches it (none exists for Electron's)
    expect(rt.server.cmd).toBe(RES + '\\node\\node.exe');
    expect(rt.server.args).toEqual([APP + '.unpacked\\dist\\server\\index.mjs']);
    expect(rt.server.cwd).toBe(WORK);
    expect(rt.server.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(rt.server.env.LOCALTUBE_UI_DIR).toBe(APP + '.unpacked\\dist\\ui');
    expect(rt.server.env.CLIPPER_RESOURCES).toBe(RES); // the server's ffmpeg calls see the same tools
  });

  it('from the repo, everything is as before', () => {
    const repoApp = 'D:\\clipper\\app';
    const rt = resolveRuntime({ isPackaged: false, appDir: repoApp, env: { Path: 'X', PYTHONPATH: 'P' }, home: HOME });
    expect(rt.root).toBe('D:\\clipper');
    expect(rt.config).toBe('D:\\clipper\\config.toml');
    expect(rt.dataDir).toBe('D:\\clipper\\data\\uploader');
    expect(rt.python).toBe('python');
    expect(rt.server.cmd).toBe('node');
    expect(rt.server.args).toEqual([repoApp + '\\node_modules\\tsx\\dist\\cli.mjs', 'src/server/index.ts']);
    expect(rt.server.cwd).toBe(repoApp);
    expect(rt.childEnv.PYTHONPATH).toBe('D:\\clipper;P');
    expect(rt.childEnv.Path).toBe('X');
  });
});

describe('work folder', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'spikecut work '));
  const fakeResources = () => {
    const res = tmp();
    fs.mkdirSync(path.join(res, 'pipeline'));
    fs.writeFileSync(path.join(res, 'pipeline', 'config.example.toml'), 'channel = ""\n[transcribe]\nmodel = "models/ggml-medium.en.bin"\nlanguage = "en"\n');
    return res;
  };

  it('creates a folder with a space in its path and a config that uses the bundled model', () => {
    const dir = path.join(tmp(), 'My Spikecut');
    expect(workfolder.prepare(dir, fakeResources())).toEqual({ created: true });
    const cfg = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    expect(cfg).toContain('model = "models/ggml-base.en.bin"');
    expect(cfg).not.toContain('ggml-medium');
    expect(cfg).toContain('language = "en"');
  });

  it('never touches a folder that already has a config (your existing work)', () => {
    const dir = tmp();
    const mine = 'channel = "mine"\n[transcribe]\nmodel = "models/ggml-large.bin"\n';
    fs.writeFileSync(path.join(dir, 'config.toml'), mine);
    expect(workfolder.prepare(dir, fakeResources())).toEqual({ created: false });
    expect(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8')).toBe(mine);
  });

  it('remembers the chosen folder', () => {
    const userData = tmp();
    expect(workfolder.readChoice(userData)).toBeNull();
    workfolder.saveChoice(userData, 'D:\\clipper');
    expect(workfolder.readChoice(userData)).toBe('D:\\clipper');
  });
});
