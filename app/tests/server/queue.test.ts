import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type Db } from '../../src/server/db/db.js';
import { buildApp } from '../../src/server/app.js';
import { addFolder, updateFolder } from '../../src/server/folders/folderRepo.js';
import { setSettings, getSettings } from '../../src/server/settings.js';
import { AuthRevokedError } from '../../src/server/youtube/accounts.js';
import { enqueueEligible } from '../../src/server/queue/enqueue.js';
import { nextRetryDelayMs, nextQuotaResetMs, MAX_ATTEMPTS } from '../../src/server/queue/retry.js';
import { startUploadWorker, type UploadWorker } from '../../src/server/queue/uploadWorker.js';
import { recover } from '../../src/server/queue/recovery.js';
import { cancelJob, retryJob, resolveUnknown } from '../../src/server/queue/actions.js';
import { startSession, uploadFrom } from '../../src/server/youtube/upload.js';
import { sha256File } from '../../src/server/scan/fingerprint.js';
import { startFakeYouTube, type FakeYouTube } from '../fixtures/fakeYouTube.js';
import { tempDir } from '../fixtures/make-fixtures.js';

const CHUNK = 256 * 1024;
let yt: FakeYouTube;
let db: Db;
let accountId: number;
let worker: UploadWorker | undefined;

beforeEach(async () => {
  yt = await startFakeYouTube();
  db = openDb(':memory:');
  accountId = Number(db.prepare("INSERT INTO youtube_accounts(channel_id, channel_title, confirmed, is_enabled, secret_ref) VALUES('UC1','Chan',1,1,'ref')").run().lastInsertRowid);
  worker = undefined;
});
afterEach(async () => {
  await worker?.stop();
  await yt.close();
});

interface Made { id: number; file: string; folderId: number }
let counter = 0;
/** A VALID video with READY metadata in a fresh folder, backed by a real random file. */
function makeVideo(o: { bytes?: number; autoPublish?: number; approval?: string; confidence?: string; folderId?: number; content?: Buffer } = {}): Made {
  const dir = tempDir('lt-q-');
  const file = path.join(dir, `clip${++counter}.mp4`);
  fs.writeFileSync(file, o.content ?? crypto.randomBytes(o.bytes ?? 700_000));
  const st = fs.statSync(file);
  const folder = o.folderId ? { id: o.folderId } : addFolder(db, { path: dir });
  updateFolder(db, folder.id, { auto_publish: o.autoPublish ?? 1, default_visibility: 'unlisted' });
  const id = Number(
    db
      .prepare("INSERT INTO videos(folder_id,file_path,filename,file_size_bytes,modified_at,discovery_status,metadata_status,approval_status) VALUES(?,?,?,?,?,'VALID','READY',?)")
      .run(folder.id, file, path.basename(file), st.size, Math.trunc(st.mtimeMs), o.approval ?? 'NOT_REQUIRED').lastInsertRowid,
  );
  db.prepare("INSERT INTO video_metadata(video_id,title,description,hashtags_json,category_id,confidence,is_current,content_hash) VALUES(?,?,?,?,?,?,1,NULL)").run(
    id, `Title ${id}`, `Description ${id}`, '["#Shorts","#Clutch"]', '20', o.confidence ?? 'high',
  );
  return { id, file, folderId: folder.id };
}
const job = (id: number) => db.prepare('SELECT * FROM upload_jobs WHERE id = ?').get(id) as Record<string, any>;
const jobForVideo = (videoId: number) => db.prepare('SELECT * FROM upload_jobs WHERE video_id = ? ORDER BY id DESC').get(videoId) as Record<string, any> | undefined;
const vstatus = (id: number) => (db.prepare('SELECT upload_status s FROM videos WHERE id=?').get(id) as { s: string }).s;
const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { c: number }).c;

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const okAuth = { getAccessToken: async () => 'AT' };
function start(over: Partial<Parameters<typeof startUploadWorker>[0]> = {}, concurrency = 1): UploadWorker {
  worker = startUploadWorker({ db, auth: okAuth, baseUrl: yt.baseUrl, chunkBytes: CHUNK, pollMs: 10, retryBaseMs: 5, ...over }, concurrency);
  return worker;
}
const settled = () => count("SELECT COUNT(*) c FROM upload_jobs WHERE status IN ('QUEUED','UPLOADING','RETRY_WAIT')") === 0;

describe('retry timing', () => {
  it('backs off exponentially with jitter inside bounds for attempts 1..6', () => {
    for (let a = 1; a <= MAX_ATTEMPTS; a++) {
      const raw = Math.min(30_000 * 2 ** (a - 1), 30 * 60_000);
      expect(nextRetryDelayMs(a, () => 0)).toBeCloseTo(raw * 0.75, 0);
      expect(nextRetryDelayMs(a, () => 1)).toBeCloseTo(raw * 1.25, 0);
      const mid = nextRetryDelayMs(a, () => 0.5);
      expect(mid).toBeGreaterThanOrEqual(raw * 0.75);
      expect(mid).toBeLessThanOrEqual(raw * 1.25);
    }
  });

  it('honours Retry-After when it is longer than the backoff', () => {
    expect(nextRetryDelayMs(1, () => 0.5, 120_000)).toBe(120_000);
    expect(nextRetryDelayMs(1, () => 0.5, 1_000)).toBeGreaterThan(1_000);
  });

  it('quota resets at the next midnight Pacific time', () => {
    expect(nextQuotaResetMs(Date.parse('2026-11-19T12:00:00Z'), 0)).toBe(Date.parse('2026-11-20T08:00:00Z'));
    expect(nextQuotaResetMs(Date.parse('2026-07-19T12:00:00Z'), 0)).toBe(Date.parse('2026-07-20T07:00:00Z'));
    expect(nextQuotaResetMs(Date.parse('2026-11-19T12:00:00Z'))).toBe(Date.parse('2026-11-20T08:05:00Z'));
  });
});

describe('enqueueEligible', () => {
  it('queues confident auto-publish videos, snapshotting visibility, account and metadata', async () => {
    const v = makeVideo();
    expect(await enqueueEligible(db)).toBe(1);
    const j = jobForVideo(v.id)!;
    expect(j).toMatchObject({ status: 'QUEUED', visibility: 'unlisted', youtube_account_id: accountId });
    expect(j.metadata_id).toBeTruthy();
    expect(j.file_fingerprint).toMatch(new RegExp(`^${fs.statSync(v.file).size}:\\d+:[0-9a-f]{64}$`));
    expect(vstatus(v.id)).toBe('QUEUED');
  });

  it('is idempotent: a second run creates no new jobs', async () => {
    makeVideo();
    expect(await enqueueEligible(db)).toBe(1);
    expect(await enqueueEligible(db)).toBe(0);
    expect(count('SELECT COUNT(*) c FROM upload_jobs')).toBe(1);
  });

  it('skips pending, rejected and manual-review videos, queues approved ones', async () => {
    const pending = makeVideo({ approval: 'PENDING', autoPublish: 0 });
    const rejected = makeVideo({ approval: 'REJECTED' });
    const manualNotApproved = makeVideo({ approval: 'NOT_REQUIRED', autoPublish: 0 });
    const approved = makeVideo({ approval: 'APPROVED', autoPublish: 0 });
    expect(await enqueueEligible(db)).toBe(1);
    expect(jobForVideo(approved.id)).toBeTruthy();
    for (const v of [pending, rejected, manualNotApproved]) expect(jobForVideo(v.id)).toBeUndefined();
  });

  it('queues nothing without a confirmed, enabled channel', async () => {
    makeVideo();
    db.prepare('UPDATE youtube_accounts SET confirmed = 0').run();
    expect(await enqueueEligible(db)).toBe(0);
    db.prepare('UPDATE youtube_accounts SET confirmed = 1, is_enabled = 0').run();
    expect(await enqueueEligible(db)).toBe(0);
  });

  it('does not queue a byte-identical duplicate of a queued video', async () => {
    const content = crypto.randomBytes(100_000);
    const a = makeVideo({ content });
    const b = makeVideo({ content });
    expect(await enqueueEligible(db)).toBe(1);
    expect(jobForVideo(a.id)).toBeTruthy();
    expect(jobForVideo(b.id)).toBeUndefined();
    expect((db.prepare('SELECT discovery_status s FROM videos WHERE id=?').get(b.id) as any).s).toBe('DUPLICATE');
  });

  it('skips a video whose file changed since discovery', async () => {
    const v = makeVideo();
    fs.appendFileSync(v.file, 'more');
    expect(await enqueueEligible(db)).toBe(0);
    expect(jobForVideo(v.id)).toBeUndefined();
  });
});

describe('upload worker', () => {
  it('uploads a queued video, stores the YouTube id, and sends the right metadata', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_COMPLETE');
    const j = jobForVideo(v.id)!;
    expect(j.youtube_video_id).toBe('vid1');
    expect(j.upload_completed_at).toBeTruthy();
    expect(vstatus(v.id)).toBe('UPLOAD_COMPLETE');
    expect(yt.videos[0].sha256).toBe(await sha256File(v.file));
    const sent = yt.startRequests[0].body;
    expect(sent.snippet).toMatchObject({ title: `Title ${v.id}`, categoryId: '20', tags: ['Shorts', 'Clutch'] });
    expect(sent.snippet.description).toBe(`Description ${v.id}\n\n#Shorts #Clutch`);
    expect(sent.status.privacyStatus).toBe('unlisted');
  });

  it('review focus 3: quota error mid-batch blocks the rest, loses nothing, and resumes on retry', async () => {
    const vs = [1, 2, 3, 4, 5].map(() => makeVideo());
    await enqueueEligible(db);
    yt.failStartNth = { n: 2, status: 403, body: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } };
    start();
    await waitFor(() => count("SELECT COUNT(*) c FROM upload_jobs WHERE status='BLOCKED_BY_QUOTA'") === 4);
    expect(count("SELECT COUNT(*) c FROM upload_jobs WHERE status='UPLOAD_COMPLETE'")).toBe(1);
    expect(count("SELECT COUNT(*) c FROM upload_jobs WHERE status='FAILED_PERMANENTLY'")).toBe(0);
    expect(count('SELECT COUNT(*) c FROM upload_jobs')).toBe(5);
    expect(yt.sessionsStarted).toBe(1);
    const blocked = db.prepare("SELECT * FROM upload_jobs WHERE status='BLOCKED_BY_QUOTA'").all() as any[];
    for (const b of blocked) expect(Date.parse(b.next_retry_at)).toBeGreaterThan(Date.now());
    expect(blocked.every((b) => /quota/i.test(b.last_error_message ?? ''))).toBe(true);

    for (const b of blocked) retryJob(db, b.id);
    await waitFor(() => count("SELECT COUNT(*) c FROM upload_jobs WHERE status='UPLOAD_COMPLETE'") === 5);
    expect(yt.videos).toHaveLength(5);
    expect(vs.every((v) => vstatus(v.id) === 'UPLOAD_COMPLETE')).toBe(true);
  });

  it('blocked-by-quota jobs resume by themselves once the reset time has passed', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    const j = jobForVideo(v.id)!;
    db.prepare("UPDATE upload_jobs SET status='BLOCKED_BY_QUOTA', next_retry_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), j.id);
    start();
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
  });

  it('a channel upload limit blocks everything and does NOT auto-resume', async () => {
    makeVideo();
    makeVideo();
    await enqueueEligible(db);
    yt.failNextStart = { status: 403, body: { error: { code: 403, message: 'upload limit', errors: [{ reason: 'uploadLimitExceeded' }] } } };
    start();
    await waitFor(() => count("SELECT COUNT(*) c FROM upload_jobs WHERE status='BLOCKED_BY_CHANNEL_LIMIT'") === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(count("SELECT COUNT(*) c FROM upload_jobs WHERE status='BLOCKED_BY_CHANNEL_LIMIT'")).toBe(2);
    expect(yt.sessionsStarted).toBe(0);
    expect(db.prepare("SELECT next_retry_at FROM upload_jobs WHERE status='BLOCKED_BY_CHANNEL_LIMIT'").get()).toEqual({ next_retry_at: null });
  });

  it('retries a transient start failure with backoff and then succeeds', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    yt.failStartNth = { n: 1, status: 503, headers: { 'retry-after': '0' } };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_COMPLETE');
    expect(jobForVideo(v.id)!.attempt_count).toBe(2);
    expect(yt.videos).toHaveLength(1);
  });

  it('gives up after 6 transient attempts as FAILED_PERMANENTLY, and a manual retry resets the count', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    yt.failStartAlways = { status: 503 };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'FAILED_PERMANENTLY', 20000);
    const j = jobForVideo(v.id)!;
    expect(j.attempt_count).toBe(6);
    expect(yt.startRequests).toHaveLength(6);
    expect(j.last_error_message).toBeTruthy();
    yt.failStartAlways = undefined;
    retryJob(db, j.id);
    expect(job(j.id)).toMatchObject({ status: 'QUEUED', attempt_count: 0 });
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
  });

  it('a permanent error fails at once without retrying', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    yt.failStartAlways = { status: 400, body: { error: { code: 400, message: 'invalid metadata', errors: [{ reason: 'invalidMetadata' }] } } };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'FAILED_PERMANENTLY');
    expect(jobForVideo(v.id)!.attempt_count).toBe(1);
    expect(yt.startRequests).toHaveLength(1);
    expect(vstatus(v.id)).toBe('FAILED_PERMANENTLY');
  });

  it('with one upload worker, never two uploads at once', async () => {
    [1, 2, 3, 4].forEach(() => makeVideo());
    await enqueueEligible(db);
    let max = 0;
    const t = setInterval(() => (max = Math.max(max, count("SELECT COUNT(*) c FROM upload_jobs WHERE status='UPLOADING'"))), 1);
    start({}, 1);
    await waitFor(() => count("SELECT COUNT(*) c FROM upload_jobs WHERE status='UPLOAD_COMPLETE'") === 4);
    clearInterval(t);
    expect(max).toBe(1);
    expect(yt.maxActiveData).toBe(1);
  });

  it('changing a folder auto-publish setting does not alter an already queued job', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    updateFolder(db, v.folderId, { auto_publish: 0, default_visibility: 'private' });
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_COMPLETE');
    expect(yt.startRequests[0].body.status.privacyStatus).toBe('unlisted');
  });

  it('a source file changed after queueing pauses the job, marks metadata STALE, and starts no session', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    fs.appendFileSync(v.file, 'edited');
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_PAUSED');
    expect(jobForVideo(v.id)!.last_error_code).toBe('file_changed');
    expect((db.prepare('SELECT metadata_status s FROM videos WHERE id=?').get(v.id) as any).s).toBe('STALE');
    expect(yt.sessionsStarted).toBe(0);
  });

  it('a missing source file pauses the job instead of failing it', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    fs.rmSync(v.file);
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_PAUSED');
    expect(jobForVideo(v.id)!.last_error_code).toBe('file_missing');
  });

  it('revoked Google access pauses the job and the whole queue without starting a session', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    start({ auth: { getAccessToken: async () => { throw new AuthRevokedError(); } } });
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_PAUSED');
    expect(jobForVideo(v.id)!.last_error_code).toBe('auth');
    expect(getSettings(db).queuePaused).toBe(true);
    expect(yt.sessionsStarted).toBe(0);
  });
});

describe('uncertain outcomes and recovery', () => {
  it('review focus 4: a crash mid-upload resumes from the server offset and creates exactly one video', async () => {
    const v = makeVideo({ bytes: 1_000_000 });
    await enqueueEligible(db);
    const j = jobForVideo(v.id)!;
    // What the crashed process had persisted: an UPLOADING job with a live session and part of the bytes sent.
    const uri = await startSession('AT', { title: 't', description: 'd', tags: [], categoryId: '20', visibility: 'unlisted', selfDeclaredMadeForKids: false }, fs.statSync(v.file).size, { baseUrl: yt.baseUrl });
    const ac = new AbortController();
    await uploadFrom(uri, v.file, 0, (sent) => { if (sent >= CHUNK) ac.abort(); }, ac.signal, { chunkBytes: CHUNK }).catch(() => undefined);
    db.prepare("UPDATE upload_jobs SET status='UPLOADING', resumable_session_reference=?, attempt_count=1, bytes_sent=? WHERE id=?").run(uri, CHUNK, j.id);
    db.prepare("UPDATE videos SET upload_status='UPLOADING' WHERE id=?").run(v.id);
    expect(yt.sessionsStarted).toBe(1);

    await recover(db);
    expect(job(j.id).status).toBe('QUEUED');
    start();
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
    expect(yt.sessionsStarted).toBe(1);
    expect(yt.videos).toHaveLength(1);
    expect(yt.videos[0].sha256).toBe(await sha256File(v.file));
  });

  it('a crash before any session reference was saved means no bytes were sent, so it re-queues safely', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    const j = jobForVideo(v.id)!;
    await startSession('AT', { title: 't', description: 'd', tags: [], categoryId: '20', visibility: 'unlisted', selfDeclaredMadeForKids: false }, 10, { baseUrl: yt.baseUrl }); // orphan session
    db.prepare("UPDATE upload_jobs SET status='UPLOADING', attempt_count=1 WHERE id=?").run(j.id);
    await recover(db);
    expect(job(j.id).status).toBe('QUEUED');
    expect(await enqueueEligible(db)).toBe(0);
    expect(count('SELECT COUNT(*) c FROM upload_jobs')).toBe(1);
    start();
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
    expect(yt.videos).toHaveLength(1);
  });

  it('review focus 4: a lost final response with an expired session is UPLOAD_OUTCOME_UNKNOWN and never starts a second upload', async () => {
    const v = makeVideo({ bytes: 600_000 });
    await enqueueEligible(db);
    yt.hook = (c) => {
      if (!c.isFinal) return undefined;
      yt.sessions.delete(c.sessionId); // YouTube forgets the session: we can no longer tell what happened
      return { drop: 'before' };
    };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_OUTCOME_UNKNOWN');
    await new Promise((r) => setTimeout(r, 300));
    expect(jobForVideo(v.id)!.status).toBe('UPLOAD_OUTCOME_UNKNOWN');
    expect(yt.sessionsStarted).toBe(1);
    expect(vstatus(v.id)).toBe('UPLOAD_OUTCOME_UNKNOWN');
    expect(await enqueueEligible(db)).toBe(0);
  });

  it('a lost final response is reconciled through the session when YouTube did store the video', async () => {
    const v = makeVideo({ bytes: 600_000 });
    await enqueueEligible(db);
    yt.hook = (c) => (c.isFinal ? { drop: 'after' } : undefined);
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_COMPLETE');
    expect(jobForVideo(v.id)!.youtube_video_id).toBe('vid1');
    expect(yt.sessionsStarted).toBe(1);
    expect(yt.videos).toHaveLength(1);
    expect(count("SELECT COUNT(*) c FROM activity_log WHERE event_type='upload_reconciled'")).toBe(1);
  });

  it('a lost final chunk that YouTube never stored is reconciled by resuming the same session', async () => {
    const v = makeVideo({ bytes: 600_000 });
    await enqueueEligible(db);
    let dropped = false;
    yt.hook = (c) => {
      if (c.isFinal && !dropped) {
        dropped = true;
        return { drop: 'before' };
      }
      return undefined;
    };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_COMPLETE');
    expect(yt.sessionsStarted).toBe(1);
    expect(yt.videos).toHaveLength(1);
  });

  it('the user can resolve an unknown outcome: found it, or not uploaded (retry), both audited', async () => {
    const a = makeVideo();
    const b = makeVideo();
    await enqueueEligible(db);
    const ja = jobForVideo(a.id)!;
    const jb = jobForVideo(b.id)!;
    db.prepare("UPDATE upload_jobs SET status='UPLOAD_OUTCOME_UNKNOWN', resumable_session_reference='gone' WHERE id IN (?,?)").run(ja.id, jb.id);
    resolveUnknown(db, ja.id, { action: 'found', videoId: 'abc123XYZ_-' });
    expect(job(ja.id)).toMatchObject({ status: 'UPLOAD_COMPLETE', youtube_video_id: 'abc123XYZ_-' });
    resolveUnknown(db, jb.id, { action: 'not_uploaded' });
    expect(job(jb.id)).toMatchObject({ status: 'QUEUED', resumable_session_reference: null });
    expect(count("SELECT COUNT(*) c FROM activity_log WHERE event_type='unknown_resolved'")).toBe(2);
    expect(() => resolveUnknown(db, ja.id, { action: 'not_uploaded' })).toThrow();
  });

  it('pausing mid-upload keeps the session; resuming finishes with one session and one video', async () => {
    const v = makeVideo({ bytes: 1_000_000 });
    await enqueueEligible(db);
    yt.hook = (c) => {
      if (c.nth === 2) setSettings(db, { queuePaused: true });
      return undefined;
    };
    start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_PAUSED');
    const j = jobForVideo(v.id)!;
    expect(j.last_error_code).toBe('paused_user');
    expect(j.resumable_session_reference).toBeTruthy();
    expect(j.bytes_sent).toBeGreaterThan(0);
    expect(yt.videos).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(yt.sessionsStarted).toBe(1);

    setSettings(db, { queuePaused: false });
    db.prepare("UPDATE upload_jobs SET status='QUEUED', last_error_code=NULL WHERE id=?").run(j.id);
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
    expect(yt.sessionsStarted).toBe(1);
    expect(yt.videos).toHaveLength(1);
  });

  it('cancelling an in-flight upload aborts it and the job stays CANCELLED', async () => {
    const v = makeVideo({ bytes: 1_000_000 });
    await enqueueEligible(db);
    const j = jobForVideo(v.id)!;
    yt.hook = (c) => {
      if (c.nth === 2) cancelJob(db, j.id);
      return undefined;
    };
    start();
    await waitFor(() => job(j.id).status === 'CANCELLED');
    await new Promise((r) => setTimeout(r, 200));
    expect(job(j.id).status).toBe('CANCELLED');
    expect(yt.videos).toHaveLength(0);
    expect(vstatus(v.id)).toBe('CANCELLED');
  });

  it('graceful stop pauses the active job as paused_shutdown (never complete); recover re-queues it', async () => {
    const v = makeVideo({ bytes: 1_000_000 });
    await enqueueEligible(db);
    let w!: UploadWorker;
    yt.hook = (c) => {
      if (c.nth === 2) void w.stop();
      return undefined;
    };
    w = start();
    await waitFor(() => jobForVideo(v.id)!.status === 'UPLOAD_PAUSED');
    const j = jobForVideo(v.id)!;
    expect(j.last_error_code).toBe('paused_shutdown');
    expect(j.upload_completed_at).toBeNull();
    expect(yt.videos).toHaveLength(0);

    yt.hook = undefined;
    await recover(db);
    expect(job(j.id).status).toBe('QUEUED');
    start();
    await waitFor(() => job(j.id).status === 'UPLOAD_COMPLETE');
    expect(yt.sessionsStarted).toBe(1);
    expect(yt.videos).toHaveLength(1);
  });

  it('recover leaves a user-paused job paused and does not touch finished jobs', async () => {
    const a = makeVideo();
    const b = makeVideo();
    await enqueueEligible(db);
    const ja = jobForVideo(a.id)!;
    const jb = jobForVideo(b.id)!;
    db.prepare("UPDATE upload_jobs SET status='UPLOAD_PAUSED', last_error_code='paused_user' WHERE id=?").run(ja.id);
    db.prepare("UPDATE upload_jobs SET status='UPLOAD_COMPLETE', youtube_video_id='x' WHERE id=?").run(jb.id);
    await recover(db);
    expect(job(ja.id).status).toBe('UPLOAD_PAUSED');
    expect(job(jb.id).status).toBe('UPLOAD_COMPLETE');
  });
});

describe('queue routes', () => {
  const H = { 'x-localtube-token': 't' };

  it('lists jobs with a human reason, and supports pause, resume, cancel and retry', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    const app = buildApp({ db, token: 't' });
    const list = (await app.inject({ method: 'GET', url: '/api/queue', headers: H })).json();
    expect(list.paused).toBe(false);
    expect(list.jobs[0]).toMatchObject({ video_id: v.id, status: 'QUEUED', filename: path.basename(v.file) });
    expect(list.jobs[0].reason).toMatch(/turn|queue|wait/i);

    await app.inject({ method: 'POST', url: '/api/queue/pause', headers: H });
    expect(getSettings(db).queuePaused).toBe(true);
    await app.inject({ method: 'POST', url: '/api/queue/resume', headers: H });
    expect(getSettings(db).queuePaused).toBe(false);

    const jobId = jobForVideo(v.id)!.id;
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/cancel`, headers: H })).statusCode).toBe(200);
    expect(job(jobId).status).toBe('CANCELLED');
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/retry`, headers: H })).statusCode).toBe(200);
    expect(job(jobId).status).toBe('QUEUED');
  });

  it('POST /api/queue/enqueue approves READY videos and queues them (manual-review folders)', async () => {
    const v = makeVideo({ approval: 'PENDING', autoPublish: 0 });
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: '/api/queue/enqueue', headers: H, payload: { ids: [v.id] } });
    expect(r.json()).toEqual({ queued: 1 });
    expect(jobForVideo(v.id)!.status).toBe('QUEUED');
  });

  it('selecting a video that was imported as "no approval needed" still queues it after auto-publish is turned off', async () => {
    const v = makeVideo({ approval: 'NOT_REQUIRED', autoPublish: 0 });
    expect(await enqueueEligible(db)).toBe(0); // auto-publish is off, so it is not queued by itself
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: '/api/queue/enqueue', headers: H, payload: { ids: [v.id] } });
    expect(r.json()).toEqual({ queued: 1 });
    expect(jobForVideo(v.id)!.status).toBe('QUEUED');
  });

  it('enqueue never queues a rejected video even if it is selected', async () => {
    const v = makeVideo({ approval: 'REJECTED', autoPublish: 0 });
    const app = buildApp({ db, token: 't' });
    const r = await app.inject({ method: 'POST', url: '/api/queue/enqueue', headers: H, payload: { ids: [v.id] } });
    expect(r.json()).toEqual({ queued: 0 });
  });

  it('resolve endpoint validates the YouTube id', async () => {
    const v = makeVideo();
    await enqueueEligible(db);
    const j = jobForVideo(v.id)!;
    db.prepare("UPDATE upload_jobs SET status='UPLOAD_OUTCOME_UNKNOWN' WHERE id=?").run(j.id);
    const app = buildApp({ db, token: 't' });
    const bad = await app.inject({ method: 'POST', url: `/api/jobs/${j.id}/resolve`, headers: H, payload: { action: 'found', videoId: 'not a valid id!' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/jobs/${j.id}/resolve`, headers: H, payload: { action: 'found', videoId: 'dQw4w9WgXcQ' } });
    expect(ok.statusCode).toBe(200);
    expect(job(j.id).status).toBe('UPLOAD_COMPLETE');
  });
});
