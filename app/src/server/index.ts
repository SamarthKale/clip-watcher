import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildApp } from './app.js';
import { openDb } from './db/db.js';
import { dataDir, PORT } from './config.js';
import { log, setLogDir } from './log.js';
import { startRuntime } from './runtime.js';
import { ensureLibraryFolder } from './library/library.js';

async function main() {
  const dir = dataDir();
  setLogDir(path.join(dir, 'logs'));
  const db = openDb(path.join(dir, 'localtube.db'));
  const token = crypto.randomBytes(24).toString('hex');
  // Long-lived browser session secret, kept in the data folder so a restart does not log the browser out.
  const keyFile = path.join(dir, 'session.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const sessionSecret = fs.readFileSync(keyFile, 'utf8').trim();
  // Test hook for the browser smoke test only: a fixed folder instead of the native Windows dialog.
  const testPick = process.env.LOCALTUBE_TEST_PICK_DIR;
  const app = buildApp({ db, token, sessionSecret, ...(testPick ? { pickFolder: async () => testPick } : {}) });

  // The Clip Watcher Shorts library is watched automatically: no folder picking.
  const libraryDir = process.env.CLIPPER_LIBRARY_DIR;
  if (libraryDir) ensureLibraryFolder(db, libraryDir);

  const runtime = await startRuntime({
    db,
    auth: app.deps.auth,
    getProvider: app.deps.getProvider,
    tempDir: app.deps.tempDir,
  });

  await app.listen({ host: '127.0.0.1', port: PORT });
  const url = `http://127.0.0.1:${PORT}/#token=${token}`;
  log.info('server started', { port: PORT });
  console.log(`LocalTube running: ${url}`);
  if (process.platform === 'win32' && !process.env.LOCALTUBE_NO_OPEN) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }

  // Graceful shutdown: stop taking work, pause the active upload with its session saved, flush the DB.
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    await runtime.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
