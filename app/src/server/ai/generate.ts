import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/db.js';
import { logActivity } from '../activity.js';
import { extractFrames } from '../media/frames.js';
import { fingerprintVideo } from '../scan/fingerprint.js';
import { getSettings } from '../settings.js';
import type { Folder } from '../folders/folderRepo.js';
import { AiError, type AiProvider } from './provider.js';
import { getProfile, type AiProfile } from './profileRepo.js';
import { buildPrompt } from './prompt.js';
import { validateMetadata, type Metadata } from './metadataSchema.js';
import { reviewReasons } from './safety.js';

export type OnlyField = 'title' | 'description' | 'hashtags';

export interface GenerateDeps {
  db: Db;
  provider: AiProvider;
  tempDir: string;
  frameCount?: number;
  /** Frame extractor; tests replace it to inject events at exact moments. */
  extract?: typeof extractFrames;
  /** Base delay between retries of transient provider errors. Tests set 0. */
  retryDelayMs?: number;
}

export interface GenerateOptions {
  /** Regenerate just one field; the others are kept from the current metadata. */
  only?: OnlyField;
  /** Reuse an existing result for identical bytes + prompt version + model. Default true. */
  useCache?: boolean;
}

export interface GenerateResult {
  status: 'ready' | 'failed' | 'skipped';
  error?: string;
}

interface VideoRow {
  id: number;
  folder_id: number;
  file_path: string;
  filename: string;
  duration_seconds: number | null;
  content_hash: string | null;
  metadata_status: string;
  discovery_status: string;
}
interface MetaRow {
  id: number;
  video_id: number;
  title: string;
  description: string;
  hashtags_json: string;
  confidence: string;
  needs_review: number;
  category_id: string | null;
  language: string | null;
  provider: string | null;
  model: string | null;
  prompt_version: number | null;
  ai_profile_id: number | null;
  content_hash: string | null;
}

export function decideApproval(autoPublish: boolean, confidence: string, needsReview: boolean): 'NOT_REQUIRED' | 'PENDING' {
  return autoPublish && confidence !== 'low' && !needsReview ? 'NOT_REQUIRED' : 'PENDING';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateMetadata(deps: GenerateDeps, videoId: number, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const { db, provider } = deps;
  const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId) as VideoRow | undefined;
  if (!video) return { status: 'failed', error: 'video not found' };

  if (!getSettings(db).aiConsent) {
    logActivity(db, 'video', videoId, 'ai_blocked', 'AI analysis is off: enable consent in Settings to send sampled frames to the AI provider');
    return { status: 'skipped', error: 'AI consent is off' };
  }

  const prevStatus = video.metadata_status;
  const explicit = opts.useCache === false || !!opts.only;
  const setStatus = (s: string) => db.prepare("UPDATE videos SET metadata_status = ?, updated_at = datetime('now') WHERE id = ?").run(s, videoId);
  const fail = (message: string): GenerateResult => {
    setStatus(explicit && prevStatus === 'READY' ? 'READY' : 'FAILED');
    logActivity(db, 'video', videoId, 'ai_failed', message);
    return { status: 'failed', error: message };
  };

  // Text imported from a clip JSON, or written by the user, is never replaced by an automatic AI run.
  const protectedBy = () =>
    (db.prepare("SELECT provider FROM video_metadata WHERE video_id = ? AND is_current = 1").get(videoId) as { provider: string | null } | undefined)?.provider;
  const isProtected = () => !explicit && ['manifest', 'manifest-ai', 'user-edit'].includes(protectedBy() ?? '');
  if (isProtected()) {
    setStatus('READY');
    return { status: 'ready' };
  }

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(video.folder_id) as Folder;
  const profile = folder.ai_profile_id ? getProfile(db, folder.ai_profile_id) : undefined;
  if (!profile) return fail('The folder has no AI profile assigned');
  if (video.discovery_status !== 'VALID') return fail(`Video is not ready (${video.discovery_status})`);

  setStatus('ANALYZING');
  let jobDir: string | null = null;
  try {
    const hash = video.content_hash ?? (await fingerprintVideo(db, videoId));
    const autoPublish = !!folder.auto_publish;

    if (opts.useCache !== false && !opts.only) {
      const hit = db
        .prepare('SELECT * FROM video_metadata WHERE content_hash = ? AND prompt_version = ? AND model = ? AND ai_profile_id = ? ORDER BY id DESC LIMIT 1')
        .get(hash, profile.prompt_version, provider.model, profile.id) as MetaRow | undefined;
      if (hit) {
        db.transaction(() => {
          if (hit.video_id === videoId) {
            db.prepare('UPDATE video_metadata SET is_current = 0 WHERE video_id = ?').run(videoId);
            db.prepare('UPDATE video_metadata SET is_current = 1 WHERE id = ?').run(hit.id);
          } else {
            db.prepare('UPDATE video_metadata SET is_current = 0 WHERE video_id = ?').run(videoId);
            db.prepare(
              `INSERT INTO video_metadata(video_id, ai_profile_id, prompt_version, provider, model, title, description, hashtags_json, category_id, language, confidence, needs_review, is_current, content_hash)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
            ).run(videoId, hit.ai_profile_id, hit.prompt_version, hit.provider, hit.model, hit.title, hit.description, hit.hashtags_json, hit.category_id, hit.language, hit.confidence, hit.needs_review, hash);
          }
          db.prepare("UPDATE videos SET metadata_status='READY', approval_status=?, updated_at=datetime('now') WHERE id=?").run(
            decideApproval(autoPublish, hit.confidence, !!hit.needs_review),
            videoId,
          );
        })();
        logActivity(db, 'video', videoId, 'ai_cache_hit', 'Reused metadata generated earlier for identical content');
        return { status: 'ready' };
      }
    }

    fs.mkdirSync(deps.tempDir, { recursive: true });
    jobDir = fs.mkdtempSync(path.join(deps.tempDir, 'job-'));
    const framePaths = await (deps.extract ?? extractFrames)(video.file_path, video.duration_seconds ?? 1, deps.frameCount ?? 6, jobDir);
    // A clip JSON (or the user) may have supplied the text while frames were being extracted: stop, do not ask the AI.
    if (isProtected()) {
      setStatus('READY');
      return { status: 'ready' };
    }
    const frames = framePaths.map((f) => fs.readFileSync(f));
    setStatus('GENERATING');

    const { systemPrompt, userText } = buildPrompt(profile, { fileName: video.filename, durationSec: video.duration_seconds ?? 0 });
    const fixed = safeTags(profile.fixed_hashtags);
    let value: Metadata | undefined;
    let lastErrors = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: unknown;
      try {
        raw = await provider.generate({ systemPrompt, userText, frames });
      } catch (e) {
        if (e instanceof AiError && e.retryable && attempt < 2) {
          await sleep((deps.retryDelayMs ?? 2000) * (attempt + 1));
          continue;
        }
        throw e;
      }
      const v = validateMetadata(raw, { fixedHashtags: fixed });
      if (v.ok) {
        value = v.value;
        break;
      }
      lastErrors = v.errors.join('; ');
      if (attempt >= 1) break; // invalid output gets exactly one retry
    }
    if (!value) return fail(`AI output failed validation: ${lastErrors}`);

    const cur = db.prepare('SELECT * FROM video_metadata WHERE video_id = ? AND is_current = 1').get(videoId) as MetaRow | undefined;
    const merged = {
      title: opts.only && opts.only !== 'title' && cur ? cur.title : value.title,
      description: opts.only && opts.only !== 'description' && cur ? cur.description : value.description,
      hashtags: opts.only && opts.only !== 'hashtags' && cur ? (JSON.parse(cur.hashtags_json) as string[]) : value.hashtags,
    };

    if (isProtected()) {
      setStatus('READY'); // a clip JSON was imported while the AI was working: keep it, and never leave the video mid-generation
      return { status: 'ready' };
    }
    const flags = reviewReasons(merged);
    const needsReview = value.needsReview || flags.length > 0;
    db.transaction(() => {
      db.prepare('UPDATE video_metadata SET is_current = 0 WHERE video_id = ?').run(videoId);
      db.prepare(
        `INSERT INTO video_metadata(video_id, ai_profile_id, prompt_version, provider, model, title, description, hashtags_json, category_id, language, confidence, needs_review, is_current, content_hash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      ).run(
        videoId, profile.id, profile.prompt_version, provider.name, provider.model, merged.title, merged.description,
        JSON.stringify(merged.hashtags), value!.categoryId ?? folder.default_category_id, value!.language ?? profile.language,
        value!.confidence, needsReview ? 1 : 0, hash,
      );
      db.prepare("UPDATE videos SET metadata_status='READY', approval_status=?, updated_at=datetime('now') WHERE id=?").run(
        decideApproval(autoPublish, value!.confidence, needsReview),
        videoId,
      );
    })();
    if (flags.length) logActivity(db, 'video', videoId, 'ai_flagged', `Held for review: the generated text ${flags.join(' and ')}`);
    return { status: 'ready' };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

function safeTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export type { AiProfile };
