import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { protect, unprotect } from '../../src/server/secrets/dpapi.js';
import { createSecretStore } from '../../src/server/secrets/secretStore.js';
import { getSettings, setSettings } from '../../src/server/settings.js';
import { tempDir } from '../fixtures/make-fixtures.js';

const win = process.platform === 'win32';
const H = { 'x-localtube-token': 't' };
const fakeCrypto = {
  protect: async (s: string) => Buffer.from([...s].reverse().join('')).toString('base64'),
  unprotect: async (s: string) => [...Buffer.from(s, 'base64').toString()].reverse().join(''),
};

describe('dpapi', () => {
  it.runIf(win)('round-trips unicode text', async () => {
    const secret = 'sécret-ключ-🔑-1234';
    const cipher = await protect(secret);
    expect(cipher).not.toContain('1234');
    expect(await unprotect(cipher)).toBe(secret);
  }, 30000);
});

describe('secretStore', () => {
  it.runIf(win)('secrets.json on disk does not contain the plaintext (real DPAPI)', async () => {
    const file = path.join(tempDir(), 'secrets.json');
    const store = createSecretStore(file);
    await store.set('geminiApiKey', 'PLAINTEXT-API-KEY-987');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('PLAINTEXT-API-KEY-987');
    expect(await createSecretStore(file).get('geminiApiKey')).toBe('PLAINTEXT-API-KEY-987');
  }, 30000);

  it('set, get, overwrite and delete', async () => {
    const store = createSecretStore(path.join(tempDir(), 's.json'), fakeCrypto);
    expect(await store.get('a')).toBeNull();
    await store.set('a', 'one');
    await store.set('a', 'two');
    expect(await store.get('a')).toBe('two');
    await store.delete('a');
    expect(await store.get('a')).toBeNull();
  });

  it('survives a new store instance reading the same file', async () => {
    const file = path.join(tempDir(), 's.json');
    await createSecretStore(file, fakeCrypto).set('k', 'v');
    expect(await createSecretStore(file, fakeCrypto).get('k')).toBe('v');
  });
});

describe('settings', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('has safe defaults: consent off, 2 AI workers, 1 upload worker', () => {
    expect(getSettings(db)).toMatchObject({ aiConsent: false, aiWorkers: 2, uploadWorkers: 1, stableMs: 2000 });
  });

  it('rejects out-of-range worker counts', () => {
    expect(() => setSettings(db, { aiWorkers: 0 })).toThrow();
    expect(() => setSettings(db, { aiWorkers: 5 })).toThrow();
    expect(() => setSettings(db, { uploadWorkers: 9 })).toThrow();
    expect(() => setSettings(db, { uploadWorkers: 0 })).toThrow();
    expect(setSettings(db, { aiWorkers: 4, uploadWorkers: 2 })).toMatchObject({ aiWorkers: 4, uploadWorkers: 2 });
  });

  it('persists consent', () => {
    setSettings(db, { aiConsent: true });
    expect(getSettings(db).aiConsent).toBe(true);
  });
});

describe('settings routes', () => {
  it('never returns the Gemini key, only whether it is set', async () => {
    const db = openDb(':memory:');
    const secrets = createSecretStore(path.join(tempDir(), 's.json'), fakeCrypto);
    const app = buildApp({ db, token: 't', secrets });
    expect((await app.inject({ method: 'GET', url: '/api/settings', headers: H })).json().geminiKeySet).toBe(false);
    const put = await app.inject({ method: 'PUT', url: '/api/settings/gemini-key', headers: H, payload: { key: 'SUPER-SECRET-KEY' } });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain('SUPER-SECRET-KEY');
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: H });
    expect(get.body).not.toContain('SUPER-SECRET-KEY');
    expect(get.json().geminiKeySet).toBe(true);
    expect(await secrets.get('geminiApiKey')).toBe('SUPER-SECRET-KEY');
  });

  it('PUT /api/settings validates and returns 400 for bad values', async () => {
    const app = buildApp({ db: openDb(':memory:'), token: 't', secrets: createSecretStore(path.join(tempDir(), 's.json'), fakeCrypto) });
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { aiWorkers: 0 } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { aiConsent: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().aiConsent).toBe(true);
  });

  it('DELETE /api/settings/gemini-key removes the key', async () => {
    const secrets = createSecretStore(path.join(tempDir(), 's.json'), fakeCrypto);
    const app = buildApp({ db: openDb(':memory:'), token: 't', secrets });
    await secrets.set('geminiApiKey', 'k');
    await app.inject({ method: 'DELETE', url: '/api/settings/gemini-key', headers: H });
    expect(await secrets.get('geminiApiKey')).toBeNull();
  });
});
