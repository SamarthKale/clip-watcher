// A separate OS process running the real runtime against fake Google, Gemini and YouTube servers.
// The end-to-end test SIGKILLs it mid-upload to prove crash recovery. Test code only.
import path from 'node:path';
import { GeminiProvider } from '../../src/server/ai/gemini.js';
import { openDb } from '../../src/server/db/db.js';
import { log, setLogDir } from '../../src/server/log.js';
import { startRuntime } from '../../src/server/runtime.js';
import { createSecretStore } from '../../src/server/secrets/secretStore.js';
import { createAccountAuth } from '../../src/server/youtube/accounts.js';

const cfg = JSON.parse(process.env.HARNESS ?? '{}') as {
  dataDir: string; ytBase: string; geminiBase: string; tokenUrl: string; chunkBytes: number;
};

setLogDir(path.join(cfg.dataDir, 'logs'));
const db = openDb(path.join(cfg.dataDir, 'localtube.db'));
const secrets = createSecretStore(path.join(cfg.dataDir, 'secrets.json'));
const auth = createAccountAuth({
  db,
  secrets,
  endpoints: { authUrl: '', tokenUrl: cfg.tokenUrl, channelsUrl: '' },
  getClient: () => ({ clientId: 'e2e-client' }),
});

const runtime = await startRuntime({
  db,
  auth,
  getProvider: async () => {
    const key = await secrets.get('geminiApiKey');
    return key ? new GeminiProvider(key, 'gemini-e2e', { baseUrl: cfg.geminiBase }) : null;
  },
  tempDir: () => path.join(cfg.dataDir, 'tmp'),
  uploadBaseUrl: cfg.ytBase,
  chunkBytes: cfg.chunkBytes,
  retryBaseMs: 50,
  pollMs: 20,
  statusIntervalMs: 200,
  scanIntervalMs: 0,
});
log.info('harness started');
console.log('HARNESS_READY');

process.on('SIGTERM', () => {
  void runtime.stop().then(() => {
    db.close();
    process.exit(0);
  });
});
setInterval(() => undefined, 1 << 30); // stay alive
