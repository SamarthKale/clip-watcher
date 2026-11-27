import type { Db } from './db/db.js';
import { startAiWorker } from './ai/aiWorker.js';
import type { AiProvider } from './ai/provider.js';
import { startLibrarySync } from './library/library.js';
import { recover } from './queue/recovery.js';
import { startUploadWorker } from './queue/uploadWorker.js';
import { startScanLoop } from './scan/scanLoop.js';
import { getSettings } from './settings.js';
import { makeFetchVideos, startStatusMonitor, type PollDeps } from './youtube/statusMonitor.js';

export interface RuntimeDeps {
  db: Db;
  auth: { getAccessToken(accountId: number): Promise<string> };
  getProvider: () => Promise<AiProvider | null>;
  tempDir: () => string;
  /** Overrides the YouTube base URL (tests). */
  uploadBaseUrl?: string;
  fetchVideos?: PollDeps['fetchVideos'];
  pollMs?: number;
  /** Upload chunk size in bytes (multiple of 256 KiB). Tests use small chunks to crash mid-upload. */
  chunkBytes?: number;
  /** Base backoff for upload retries in ms (tests shorten it). */
  retryBaseMs?: number;
  statusIntervalMs?: number;
  /** Overrides the scan interval setting (tests). */
  scanIntervalMs?: number;
}

/**
 * Starts every background loop. Order matters: recovery runs first, from persisted state only, so
 * nothing is scheduled from in-memory assumptions. `stop()` is idempotent and leaves interrupted
 * uploads paused (never complete) with their session intact.
 */
export async function startRuntime(deps: RuntimeDeps): Promise<{ stop(): Promise<void> }> {
  const { db } = deps;
  await recover(db);

  const ai = startAiWorker({ db, getProvider: deps.getProvider, tempDir: deps.tempDir, pollMs: deps.pollMs }, () => getSettings(db).aiWorkers);
  const upload = startUploadWorker({ db, auth: deps.auth, baseUrl: deps.uploadBaseUrl, pollMs: deps.pollMs, chunkBytes: deps.chunkBytes, retryBaseMs: deps.retryBaseMs }, () => getSettings(db).uploadWorkers);
  const monitor = startStatusMonitor(
    { db, getToken: (id) => deps.auth.getAccessToken(id), fetchVideos: deps.fetchVideos ?? makeFetchVideos({ baseUrl: deps.uploadBaseUrl }) },
    deps.statusIntervalMs ?? 60_000,
  );
  const scan = startScanLoop(db, {
    intervalMs: () => deps.scanIntervalMs ?? getSettings(db).scanIntervalMin * 60_000,
    stableMs: () => getSettings(db).stableMs,
    enhance: async () => {
      const s = getSettings(db);
      return s.enhanceImports && s.aiConsent && !!(await deps.getProvider());
    },
  });

  const librarySync = startLibrarySync(db, deps.statusIntervalMs ? Math.max(1000, deps.statusIntervalMs) : 30_000);

  let stopping: Promise<void> | null = null;
  return {
    stop: () =>
      (stopping ??= (async () => {
        scan.stop();
        librarySync.stop();
        monitor.stop();
        await upload.stop();
        await ai.stop();
      })()),
  };
}
