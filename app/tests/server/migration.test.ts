import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../../src/server/db/db.js';
import { tempDir } from '../fixtures/make-fixtures.js';

/** Builds a database exactly as version 1 of the app left it, with real-looking data in it. */
function makeV1(file: string): void {
  const db = new Database(file);
  db.exec(fs.readFileSync(path.resolve('src/server/db/schema.sql'), 'utf8'));
  db.pragma('user_version = 1');
  db.prepare("INSERT INTO ai_profiles(name) VALUES('Default')").run();
  db.prepare("INSERT INTO folders(path,display_name,ai_profile_id) VALUES('D:\\\\clips','clips',1)").run();
  db.prepare("INSERT INTO videos(folder_id,file_path,filename,metadata_status,upload_status) VALUES(1,'D:\\\\clips\\\\a.mp4','a.mp4','READY','UPLOAD_COMPLETE')").run();
  db.prepare("INSERT INTO video_metadata(video_id,provider,title,description,hashtags_json,is_current) VALUES(1,'manifest','Old title','Old desc','[\"#a\"]',1)").run();
  db.prepare("INSERT INTO upload_jobs(video_id,status,youtube_video_id,visibility) VALUES(1,'UPLOAD_COMPLETE','abcdefghijk','public')").run();
  db.prepare("INSERT INTO settings(key,value) VALUES('aiConsent','true')").run();
  db.close();
}

describe('database migrations', () => {
  it('upgrades a version 1 database in place and keeps every row', () => {
    const file = path.join(tempDir('lt-mig-'), 'localtube.db');
    makeV1(file);
    const db = openDb(file);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare('SELECT title FROM video_metadata').get()).toEqual({ title: 'Old title' });
    expect(db.prepare('SELECT youtube_video_id y FROM upload_jobs').get()).toEqual({ y: 'abcdefghijk' });
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('aiConsent')).toEqual({ value: 'true' });
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('video_metadata')).toEqual(expect.arrayContaining(['source_json', 'source_hash']));
    expect(cols('videos')).toContain('enhance_status');
    expect(db.prepare('SELECT enhance_status e FROM videos').get()).toEqual({ e: 'NONE' });
    db.close();
  });

  it('backs the file up before migrating, and does nothing the second time', () => {
    const dir = tempDir('lt-mig2-');
    const file = path.join(dir, 'localtube.db');
    makeV1(file);
    openDb(file).close();
    expect(fs.existsSync(`${file}.bak-1`)).toBe(true);
    const backup = new Database(`${file}.bak-1`, { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(1);
    expect(backup.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 1 });
    backup.close();
    const again = openDb(file);
    expect(again.pragma('user_version', { simple: true })).toBe(2);
    expect(again.prepare('SELECT COUNT(*) c FROM videos').get()).toEqual({ c: 1 });
    again.close();
  });

  it('a brand new database ends at the latest version', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(2);
  });
});
