import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/server/db/db.js';
import { getSettings, setSettings } from '../../src/server/settings.js';

describe('first-run tour flag', () => {
  it('starts unseen and is remembered once set', () => {
    const db = openDb(':memory:');
    expect(getSettings(db).tourSeen).toBe(false);
    expect(setSettings(db, { tourSeen: true }).tourSeen).toBe(true);
    expect(getSettings(db).tourSeen).toBe(true);
  });

  it('rejects a non-boolean value', () => {
    const db = openDb(':memory:');
    expect(() => setSettings(db, { tourSeen: 'yes' })).toThrow();
    expect(getSettings(db).tourSeen).toBe(false);
  });
});
