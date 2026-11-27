import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';

describe('built UI location', () => {
  const before = process.env.LOCALTUBE_UI_DIR;
  afterEach(() => {
    if (before === undefined) delete process.env.LOCALTUBE_UI_DIR;
    else process.env.LOCALTUBE_UI_DIR = before;
  });

  it('serves the UI from LOCALTUBE_UI_DIR (the installed app keeps it outside the working folder)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt ui-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>bundled-ui-marker</title>');
    process.env.LOCALTUBE_UI_DIR = dir;
    const app = buildApp({ db: openDb(':memory:'), token: 't0k' });
    const r = await app.inject({ method: 'GET', url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('bundled-ui-marker');
    await app.close();
  });
});
