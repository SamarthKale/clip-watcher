import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/server/db/db.js';

function seedVideo(db: ReturnType<typeof openDb>) {
  db.prepare("INSERT INTO folders(path,display_name) VALUES('D:\\a','a')").run();
  db.prepare("INSERT INTO videos(folder_id,file_path,filename) VALUES(1,'D:\\a\\x.mp4','x.mp4')").run();
}

describe('openDb', () => {
  it('creates all tables', () => {
    const db = openDb(':memory:');
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['folders', 'ai_profiles', 'videos', 'video_metadata', 'youtube_accounts', 'upload_jobs', 'activity_log', 'settings']) {
      expect(names).toContain(t);
    }
  });

  it('rejects two active upload jobs for one video', () => {
    const db = openDb(':memory:');
    seedVideo(db);
    const ins = db.prepare("INSERT INTO upload_jobs(video_id,status) VALUES(1,?)");
    ins.run('QUEUED');
    expect(() => ins.run('UPLOADING')).toThrow(/UNIQUE/);
  });

  it('allows a new active job after a terminal one', () => {
    const db = openDb(':memory:');
    seedVideo(db);
    const ins = db.prepare("INSERT INTO upload_jobs(video_id,status) VALUES(1,?)");
    ins.run('CANCELLED');
    expect(() => ins.run('QUEUED')).not.toThrow();
  });

  it('enforces foreign keys', () => {
    const db = openDb(':memory:');
    expect(() => db.prepare("INSERT INTO videos(folder_id,file_path,filename) VALUES(99,'p','f')").run()).toThrow(/FOREIGN/);
  });
});
