import Database from 'better-sqlite3';
import fs from 'node:fs';
import { ensureDefaultProfile } from '../ai/profileRepo.js';

export type Db = Database.Database;

const read = (name: string) => fs.readFileSync(new URL(name, import.meta.url), 'utf8');

/** Schema versions. Version 1 is the baseline and is never edited; changes ship as new numbered migrations. */
const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: read('./schema.sql') },
  { version: 2, sql: read('./migrations/002-enhance.sql') },
];

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((x) => x.version > current);
  // An existing database holds real data: copy it before changing its structure.
  if (pending.length && current > 0 && file !== ':memory:') {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(file, `${file}.bak-${current}`);
  }
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  ensureDefaultProfile(db);
  return db;
}
