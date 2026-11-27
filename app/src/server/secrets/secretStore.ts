import fs from 'node:fs';
import path from 'node:path';
import { protect, unprotect } from './dpapi.js';

export interface SecretCrypto {
  protect(plain: string): Promise<string>;
  unprotect(cipher: string): Promise<string>;
}

export interface SecretStore {
  set(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  delete(name: string): Promise<void>;
}

/**
 * Stores secrets encrypted at rest in a JSON file outside the database. SQLite only ever
 * holds the secret's name. Decrypted values are cached in memory to avoid respawning PowerShell.
 */
export function createSecretStore(file: string, crypto: SecretCrypto = { protect, unprotect }): SecretStore {
  const cache = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // Serialise writes so concurrent set() calls cannot lose updates.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    set: (name, value) =>
      serial(async () => {
        const cipher = await crypto.protect(value);
        write({ ...read(), [name]: cipher });
        cache.set(name, value);
      }),
    get: async (name) => {
      if (cache.has(name)) return cache.get(name)!;
      const cipher = read()[name];
      if (!cipher) return null;
      const plain = await crypto.unprotect(cipher);
      cache.set(name, plain);
      return plain;
    },
    delete: (name) =>
      serial(async () => {
        const data = read();
        delete data[name];
        write(data);
        cache.delete(name);
      }),
  };
}
