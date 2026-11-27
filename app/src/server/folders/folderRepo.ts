import path from 'node:path';
import type { Db } from '../db/db.js';
import type { Visibility } from '../types.js';

export interface Folder {
  id: number;
  path: string;
  display_name: string;
  recursive_scan: number;
  monitor_enabled: number;
  ai_profile_id: number | null;
  auto_publish: number;
  default_visibility: Visibility;
  default_category_id: string;
  default_playlist_id: string | null;
  is_enabled: number;
  last_scan_at: string | null;
}

export type FolderSettings = Pick<
  Folder,
  'recursive_scan' | 'monitor_enabled' | 'ai_profile_id' | 'auto_publish' | 'default_visibility' | 'default_category_id' | 'default_playlist_id' | 'display_name'
>;

const EDITABLE: (keyof FolderSettings)[] = [
  'recursive_scan', 'monitor_enabled', 'ai_profile_id', 'auto_publish', 'default_visibility', 'default_category_id', 'default_playlist_id', 'display_name',
];

function normalize(p: string): string {
  const n = path.win32.normalize(p);
  return n.length > 3 ? n.replace(/[\\/]+$/, '') : n;
}

function getFolder(db: Db, id: number): Folder {
  return db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Folder;
}

export function addFolder(db: Db, input: { path: string; recursive?: boolean }): Folder {
  const p = normalize(input.path);
  const existing = db.prepare('SELECT * FROM folders WHERE path = ?').get(p) as Folder | undefined;
  if (existing) {
    if (!existing.is_enabled) db.prepare("UPDATE folders SET is_enabled = 1, updated_at = datetime('now') WHERE id = ?").run(existing.id);
    return getFolder(db, existing.id);
  }
  const profile = db.prepare('SELECT id FROM ai_profiles ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  const info = db
    .prepare('INSERT INTO folders(path, display_name, recursive_scan, ai_profile_id) VALUES(?,?,?,?)')
    .run(p, path.win32.basename(p) || p, input.recursive === false ? 0 : 1, profile?.id ?? null);
  return getFolder(db, Number(info.lastInsertRowid));
}

export function listFolders(db: Db): Folder[] {
  return db.prepare('SELECT * FROM folders WHERE is_enabled = 1 ORDER BY id').all() as Folder[];
}

export function updateFolder(db: Db, id: number, patch: Partial<FolderSettings>): Folder {
  const keys = EDITABLE.filter((k) => k in patch);
  if (keys.length) {
    const sql = `UPDATE folders SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`;
    db.prepare(sql).run({ ...patch, id });
  }
  return getFolder(db, id);
}

/** Soft-removes: history and videos stay; source files are never touched. */
export function removeFolder(db: Db, id: number): void {
  db.prepare("UPDATE folders SET is_enabled = 0, updated_at = datetime('now') WHERE id = ?").run(id);
}
