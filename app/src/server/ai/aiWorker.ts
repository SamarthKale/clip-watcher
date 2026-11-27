import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { log } from '../log.js';
import { getSettings } from '../settings.js';
import { enhanceMetadata } from './enhance.js';
import { generateMetadata } from './generate.js';
import type { AiProvider } from './provider.js';

export interface AiWorkerDeps {
  db: Db;
  getProvider: () => Promise<AiProvider | null>;
  tempDir: () => string;
  pollMs?: number;
  retryDelayMs?: number;
  /** Minimum time between two Gemini enhancement requests (keeps free-tier rate limits from being hit). Default 4 s. */
  enhanceGapMs?: number;
  frameCount?: number;
}

/** After a crash, videos mid-analysis are put back in the queue. */
export function resetStuckAi(db: Db): void {
  db.prepare("UPDATE videos SET metadata_status='NOT_STARTED' WHERE metadata_status IN ('ANALYZING','GENERATING')").run();
  db.prepare("UPDATE videos SET enhance_status='PENDING' WHERE enhance_status='RUNNING'").run();
}

/**
 * Polls for VALID videos whose metadata is NOT_STARTED or STALE and generates it, at most
 * `concurrency` at a time. Idle while AI consent is off or no provider is configured.
 */
export function startAiWorker(deps: AiWorkerDeps, concurrency: number | (() => number)): { stop(): Promise<void> } {
  const { db } = deps;
  const inFlight = new Set<Promise<unknown>>();
  let stopped = false;
  /** After a daily-quota error: no more calls to that model until it should have reset. */
  let quotaBlock: { model: string; until: number } | null = null;
  let lastEnhanceStart = 0;
  resetStuckAi(db);

  const claim = db.prepare("UPDATE videos SET metadata_status='ANALYZING' WHERE id = ? AND metadata_status IN ('NOT_STARTED','STALE')");
  const claimEnhance = db.prepare("UPDATE videos SET enhance_status='RUNNING' WHERE id = ? AND enhance_status='PENDING'");
  const pendingEnhance = db.prepare("SELECT id FROM videos WHERE enhance_status='PENDING' ORDER BY id LIMIT ?");
  const candidates = db.prepare("SELECT id FROM videos WHERE discovery_status='VALID' AND metadata_status IN ('NOT_STARTED','STALE') ORDER BY id LIMIT ?");

  async function tick(): Promise<void> {
    if (stopped) return;
    const max = typeof concurrency === 'function' ? concurrency() : concurrency;
    const consent = getSettings(db).aiConsent;
    const provider = consent ? await deps.getProvider() : null;
    if (!provider) {
      // Without Gemini nothing can be improved: release the videos so uploads are never held up for it.
      const released = db.prepare("UPDATE videos SET enhance_status='NONE' WHERE enhance_status='PENDING'").run().changes;
      if (released) log.warn('Gemini is not set up; skipped improving titles', { videos: released });
      return;
    }
    if (stopped) return;
    // While a model's daily quota is used up, release waiting videos instead of calling it: uploads keep the original text.
    if (quotaBlock && (quotaBlock.model !== provider.model || Date.now() >= quotaBlock.until)) quotaBlock = null;
    if (quotaBlock) db.prepare("UPDATE videos SET enhance_status='FAILED' WHERE enhance_status='PENDING'").run();
    // Improving imported text comes first: it is quick, and uploads wait for it.
    const gap = deps.enhanceGapMs ?? 4000;
    for (const { id } of quotaBlock ? [] : (pendingEnhance.all(Math.max(0, max - inFlight.size)) as { id: number }[])) {
      if (Date.now() - lastEnhanceStart < gap) break; // pace the requests
      if (claimEnhance.run(id).changes === 0) continue;
      lastEnhanceStart = Date.now();
      const job = enhanceMetadata({ db, provider, retryDelayMs: deps.retryDelayMs }, id)
        .then((r) => {
          if (!r.stopAll) return;
          quotaBlock = { model: provider.model, until: Date.now() + Math.min(r.retryAfterMs ?? 3_600_000, 24 * 3_600_000) };
          const released = db.prepare("UPDATE videos SET enhance_status='FAILED' WHERE enhance_status='PENDING'").run().changes;
          if (released) logActivity(db, 'system', null, 'enhance_quota', `${r.error} ${released} video(s) keep their original text for now.`);
        })
        .catch((e) => log.error('enhance job crashed', { id, error: String(e) }))
        .finally(() => {
          db.prepare("UPDATE videos SET enhance_status='FAILED' WHERE id = ? AND enhance_status='RUNNING'").run(id);
          inFlight.delete(job);
        });
      inFlight.add(job);
    }
    const free = max - inFlight.size;
    if (free <= 0) return;
    for (const { id } of candidates.all(free) as { id: number }[]) {
      if (claim.run(id).changes === 0) continue;
      const job = generateMetadata(
        { db, provider, tempDir: deps.tempDir(), retryDelayMs: deps.retryDelayMs, frameCount: deps.frameCount },
        id,
      )
        .catch((e) => log.error('ai worker job crashed', { id, error: String(e) }))
        .finally(() => inFlight.delete(job));
      inFlight.add(job);
    }
  }

  const timer = setInterval(() => void tick().catch((e) => log.error('ai worker tick failed', { error: String(e) })), deps.pollMs ?? 2000);
  void tick().catch(() => undefined);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.allSettled([...inFlight]);
    },
  };
}
