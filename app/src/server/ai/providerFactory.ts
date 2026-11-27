import type { Db } from '../db/db.js';
import { GEMINI_SECRET } from '../routes/settings.js';
import type { SecretStore } from '../secrets/secretStore.js';
import { getSettings } from '../settings.js';
import { GeminiProvider } from './gemini.js';
import type { AiProvider } from './provider.js';

/** Builds a provider from the current settings and stored key, or null when no key is set. */
export function makeProviderGetter(db: Db, secrets: SecretStore): () => Promise<AiProvider | null> {
  return async () => {
    const key = await secrets.get(GEMINI_SECRET);
    if (!key) return null;
    return new GeminiProvider(key, getSettings(db).geminiModel);
  };
}
