import type { Db } from '../db/db.js';

export interface AiProfile {
  id: number;
  name: string;
  provider: string;
  model: string;
  title_prompt: string;
  description_prompt: string;
  hashtag_prompt: string;
  /** JSON array of hashtags. */
  fixed_hashtags: string;
  language: string;
  tone: string;
  target_audience: string;
  generation_settings_json: string;
  prompt_version: number;
}

export type ProfileInput = Partial<Omit<AiProfile, 'id' | 'prompt_version'>> & { name: string };

const FIELDS = [
  'name', 'provider', 'model', 'title_prompt', 'description_prompt', 'hashtag_prompt', 'fixed_hashtags',
  'language', 'tone', 'target_audience', 'generation_settings_json',
] as const;
/** Changing any of these changes generated output, so the prompt version is bumped. */
const PROMPT_FIELDS = FIELDS.filter((f) => f !== 'name');

export const DEFAULT_PROFILE: ProfileInput = {
  name: 'Gameplay Shorts Hook',
  title_prompt:
    'Write a scroll-stopping hook title for this gameplay Short. Lead with the most exciting thing that actually happens in the clip (a clutch, a fail, a glitch, a close call). Short, punchy, curiosity-driven.',
  description_prompt:
    'Write 1-3 short sentences describing what happens in the clip, then a one-line call to action to watch or follow. No filler, no repeated phrases.',
  hashtag_prompt: 'Add 3-5 relevant hashtags: the game (only if clearly recognisable), the type of moment, and the genre.',
  fixed_hashtags: '["#Shorts"]',
  tone: 'hook-driven, eye-catching, high energy but truthful',
  target_audience: 'gaming fans who watch short clips',
};

export function getProfile(db: Db, id: number): AiProfile | undefined {
  return db.prepare('SELECT * FROM ai_profiles WHERE id = ?').get(id) as AiProfile | undefined;
}

export function listProfiles(db: Db): AiProfile[] {
  return db.prepare('SELECT * FROM ai_profiles ORDER BY id').all() as AiProfile[];
}

export function createProfile(db: Db, input: ProfileInput): AiProfile {
  const cols = FIELDS.filter((f) => input[f] !== undefined);
  const info = db
    .prepare(`INSERT INTO ai_profiles(${cols.join(',')}) VALUES(${cols.map((c) => '@' + c).join(',')})`)
    .run(Object.fromEntries(cols.map((c) => [c, input[c]])));
  return getProfile(db, Number(info.lastInsertRowid))!;
}

export function updateProfile(db: Db, id: number, patch: Partial<ProfileInput>): AiProfile {
  const before = getProfile(db, id);
  if (!before) throw new Error(`profile ${id} not found`);
  const cols = FIELDS.filter((f) => patch[f] !== undefined && patch[f] !== before[f]);
  if (cols.length) {
    const bump = cols.some((c) => (PROMPT_FIELDS as readonly string[]).includes(c)) ? 1 : 0;
    db.prepare(
      `UPDATE ai_profiles SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, prompt_version = prompt_version + ${bump}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...Object.fromEntries(cols.map((c) => [c, patch[c]])), id });
  }
  return getProfile(db, id)!;
}

export function duplicateProfile(db: Db, id: number): AiProfile {
  const p = getProfile(db, id);
  if (!p) throw new Error(`profile ${id} not found`);
  const { id: _id, prompt_version: _v, ...rest } = p;
  return createProfile(db, { ...rest, name: `${p.name} (copy)` });
}

export function deleteProfile(db: Db, id: number): void {
  const used = (db.prepare('SELECT COUNT(*) c FROM folders WHERE ai_profile_id = ? AND is_enabled = 1').get(id) as { c: number }).c;
  if (used > 0) throw new Error(`Profile is in use by ${used} folder(s); assign another profile first`);
  db.transaction(() => {
    db.prepare('UPDATE folders SET ai_profile_id = NULL WHERE ai_profile_id = ?').run(id);
    db.prepare('DELETE FROM ai_profiles WHERE id = ?').run(id);
  })();
}

/** Seeds the default hook-style profile when there are no profiles at all. */
export function ensureDefaultProfile(db: Db): void {
  const n = (db.prepare('SELECT COUNT(*) c FROM ai_profiles').get() as { c: number }).c;
  if (n === 0) createProfile(db, DEFAULT_PROFILE);
}
