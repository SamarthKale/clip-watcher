'use strict';
/**
 * Where everything Spikecut starts comes from.
 *
 * From the repo (`npm run desktop`, Spikecut.cmd): the system Python and Node, the repo as the work
 * folder, exactly as before.
 * Installed: Spikecut's own Python (resources/python) on the compiled pipeline, the bundled server run
 * by Electron itself, the bundled tools first on PATH, and the work folder the user chose.
 */
const path = require('node:path').win32;

/** Copy of env with one PATH variable (Windows names it Path, Node may hand it over as PATH). */
function withPath(env, prepend) {
  const out = { ...env };
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'path') || 'Path';
  const rest = out[key] ? [out[key]] : [];
  out[key] = [...prepend, ...rest].join(';');
  return out;
}

function resolveRuntime({ isPackaged, resourcesPath, appDir, env = {}, home = '', workDir }) {
  if (!isPackaged) {
    const root = env.CLIPPER_ROOT ? path.resolve(env.CLIPPER_ROOT) : path.resolve(appDir, '..');
    const childEnv = { ...env, PYTHONUTF8: '1', PYTHONPATH: [root, env.PYTHONPATH].filter(Boolean).join(';') };
    return {
      root,
      config: env.CLIPPER_CONFIG || path.join(root, 'config.toml'),
      dataDir: env.LOCALTUBE_DATA || path.join(root, 'data', 'uploader'),
      python: env.CLIPPER_PYTHON || 'python',
      server: {
        cmd: env.CLIPPER_NODE || 'node',
        args: [path.join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/server/index.ts'],
        cwd: appDir,
        env: { ...env },
      },
      childEnv,
    };
  }
  const res = resourcesPath;
  const childEnv = withPath(env, [
    path.join(res, 'python'),
    path.join(res, 'tools', 'ffmpeg'),
    path.join(res, 'tools', 'whisper'),
    path.join(res, 'tools', 'yt-dlp'),
    path.join(home, '.local', 'bin'), // where Anthropic's installer puts Claude Code
  ]);
  delete childEnv.PYTHONHOME;
  delete childEnv.PYTHONPATH;
  Object.assign(childEnv, { CLIPPER_RESOURCES: res, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' });
  return {
    root: workDir,
    config: path.join(workDir, 'config.toml'),
    dataDir: path.join(workDir, 'data', 'uploader'),
    python: path.join(res, 'python', 'python.exe'),
    // The server runs on Spikecut's own Node (resources/node): the database module ships a ready-made
    // build for that Node, and none exists for Electron's. It and its node_modules sit unpacked.
    server: {
      cmd: path.join(res, 'node', 'node.exe'),
      args: [path.join(appDir + '.unpacked', 'dist', 'server', 'index.mjs')],
      cwd: workDir,
      env: { ...childEnv, LOCALTUBE_UI_DIR: path.join(appDir + '.unpacked', 'dist', 'ui') },
    },
    childEnv,
  };
}

module.exports = { resolveRuntime };
