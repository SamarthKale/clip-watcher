import { z } from 'zod';
import type { Db } from './db/db.js';

/** Default Gemini model; confirm availability and limits during Phase 0. */
/** A "-latest" alias keeps working when Google retires a named model; the lite model has the most free quota. */
export const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

export const SettingsSchema = z.object({
  aiConsent: z.boolean().default(false),
  aiWorkers: z.number().int().min(1).max(4).default(2),
  uploadWorkers: z.number().int().min(1).max(2).default(1),
  tempDir: z.string().default(''),
  stableMs: z.number().int().min(100).max(600_000).default(2000),
  geminiModel: z.string().min(1).default(DEFAULT_GEMINI_MODEL),
  googleClientId: z.string().default(''),
  /** Minutes between automatic folder rescans; 0 = off. */
  scanIntervalMin: z.number().int().min(0).max(1440).default(5),
  /** Improve titles, descriptions and hashtags imported from a clip JSON with Gemini (needs the key and consent). */
  enhanceImports: z.boolean().default(true),
  /** Persisted so a pause survives a restart. */
  queuePaused: z.boolean().default(false),
  /** review = every Short waits for your approval; auto = Shorts in the library upload by themselves. */
  publishMode: z.enum(['review', 'auto']).default('review'),
  /** Visibility used for Shorts from the library (review mode uses it when you approve). */
  autoVisibility: z.enum(['private', 'unlisted', 'public']).default('private'),
  /** The Clip Watcher Shorts library, registered as a watched folder automatically. */
  libraryDir: z.string().default(''),
  /** The guided tour opens by itself until it has been finished or skipped once. */
  tourSeen: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial().strict();

export function getSettings(db: Db): Settings {
  const stored: Record<string, unknown> = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
    try {
      stored[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt value, fall back to default */
    }
  }
  const parsed = SettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : SettingsSchema.parse({});
}

/** Validates then persists a partial update. Throws ZodError on invalid input. */
export function setSettings(db: Db, patch: unknown): Settings {
  const valid = SettingsPatchSchema.parse(patch);
  const upsert = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [k, v] of Object.entries(valid)) upsert.run(k, JSON.stringify(v));
  })();
  return getSettings(db);
}
