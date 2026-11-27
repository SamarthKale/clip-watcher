import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../../src/server/db/db.js';
import { AuthRevokedError } from '../../src/server/youtube/accounts.js';
import { pollProcessing, makeFetchVideos, isPublished, mapStatus, startStatusMonitor, type VideoStatus } from '../../src/server/youtube/statusMonitor.js';
import { startFakeYouTube, type FakeYouTube } from '../fixtures/fakeYouTube.js';

let db: Db;
let accountId: number;
beforeEach(() => {
  db = openDb(':memory:');
  accountId = Number(db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled,secret_ref) VALUES('UC1','C',1,1,'r')").run().lastInsertRowid);
  db.prepare("INSERT INTO folders(path,display_name) VALUES('D:\\\\f','f')").run();
});

let n = 0;
/** A video whose upload finished, with the given YouTube id. */
function uploaded(ytId: string, o: { jobStatus?: string; visibility?: string; processing?: string; account?: number } = {}): number {
  n++;
  const vid = Number(
    db.prepare("INSERT INTO videos(folder_id,file_path,filename,upload_status,processing_status) VALUES(1,?,?,?,?)").run(`D:\\f\\${n}.mp4`, `${n}.mp4`, o.jobStatus ?? 'UPLOAD_COMPLETE', o.processing ?? 'NOT_CHECKED').lastInsertRowid,
  );
  db.prepare("INSERT INTO upload_jobs(video_id,youtube_account_id,status,visibility,youtube_video_id) VALUES(?,?,?,?,?)").run(vid, o.account ?? accountId, o.jobStatus ?? 'UPLOAD_COMPLETE', o.visibility ?? 'public', ytId);
  return vid;
}
const proc = (id: number) => db.prepare('SELECT processing_status s, youtube_privacy p, processing_detail d FROM videos WHERE id=?').get(id) as { s: string; p: string | null; d: string | null };
const tokens = { getToken: async () => 'AT' };
const st = (id: string, o: Partial<VideoStatus> = {}): VideoStatus => ({ id, uploadStatus: 'processed', privacyStatus: 'public', processingStatus: 'succeeded', ...o });

describe('mapStatus', () => {
  it('maps YouTube states to LocalTube processing states', () => {
    expect(mapStatus(st('a'))).toBe('READY');
    expect(mapStatus(st('a', { uploadStatus: 'uploaded', processingStatus: 'processing' }))).toBe('PROCESSING');
    expect(mapStatus(st('a', { uploadStatus: 'uploaded', processingStatus: undefined }))).toBe('PROCESSING');
    expect(mapStatus(st('a', { uploadStatus: 'failed' }))).toBe('REJECTED');
    expect(mapStatus(st('a', { uploadStatus: 'rejected' }))).toBe('REJECTED');
    expect(mapStatus(st('a', { uploadStatus: 'deleted' }))).toBe('REJECTED');
    expect(mapStatus(st('a', { uploadStatus: 'uploaded', processingStatus: 'failed' }))).toBe('REJECTED');
    expect(mapStatus(undefined)).toBe('STATUS_UNKNOWN');
  });
});

describe('pollProcessing', () => {
  it('batches 120 ids into requests of at most 50', async () => {
    for (let i = 0; i < 120; i++) uploaded(`id${i}`);
    const sizes: number[] = [];
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => { sizes.push(ids.length); return ids.map((i) => st(i)); } });
    expect(sizes).toEqual([50, 50, 20]);
    expect((db.prepare("SELECT COUNT(*) c FROM videos WHERE processing_status='READY'").get() as any).c).toBe(120);
  });

  it('records each outcome, the observed privacy, and failure reasons', async () => {
    const ready = uploaded('r1');
    const busy = uploaded('p1');
    const failed = uploaded('f1');
    const gone = uploaded('g1');
    const map: Record<string, VideoStatus> = {
      r1: st('r1', { privacyStatus: 'unlisted' }),
      p1: st('p1', { uploadStatus: 'uploaded', processingStatus: 'processing' }),
      f1: st('f1', { uploadStatus: 'rejected', rejectionReason: 'duplicate' }),
    };
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => ids.flatMap((i) => (map[i] ? [map[i]] : [])) });
    expect(proc(ready)).toMatchObject({ s: 'READY', p: 'unlisted' });
    expect(proc(busy).s).toBe('PROCESSING');
    expect(proc(failed)).toMatchObject({ s: 'REJECTED' });
    expect(proc(failed).d).toMatch(/duplicate/);
    expect(proc(gone).s).toBe('STATUS_UNKNOWN');
  });

  it('transfer completion alone is never "published"; READY with a matching privacy is', async () => {
    const v = uploaded('x1', { visibility: 'public' });
    expect(isPublished(db, v)).toBe(false); // uploaded, not yet checked
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => ids.map((i) => st(i, { uploadStatus: 'uploaded', processingStatus: 'processing' })) });
    expect(isPublished(db, v)).toBe(false); // still processing
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => ids.map((i) => st(i, { privacyStatus: 'private' })) });
    expect(proc(v).s).toBe('READY');
    expect(isPublished(db, v)).toBe(false); // ready, but YouTube has it private while we wanted public
    db.prepare("UPDATE videos SET youtube_privacy='public' WHERE id=?").run(v);
    expect(isPublished(db, v)).toBe(true);
  });

  it('stops polling videos in terminal states but keeps polling PROCESSING and STATUS_UNKNOWN', async () => {
    const a = uploaded('a1', { processing: 'READY' });
    const b = uploaded('b1', { processing: 'REJECTED' });
    const c = uploaded('c1', { processing: 'PROCESSING' });
    const d = uploaded('d1', { processing: 'STATUS_UNKNOWN' });
    const e = uploaded('e1', { processing: 'NOT_CHECKED' });
    const seen: string[] = [];
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => { seen.push(...ids); return []; } });
    expect(seen.sort()).toEqual(['c1', 'd1', 'e1']);
    void [a, b, c, d, e];
  });

  it('only checks videos whose upload job is complete and has an id', async () => {
    uploaded('q1', { jobStatus: 'QUEUED' });
    uploaded('u1', { jobStatus: 'UPLOAD_OUTCOME_UNKNOWN' });
    uploaded('ok1');
    const seen: string[] = [];
    await pollProcessing(db, { ...tokens, fetchVideos: async (ids) => { seen.push(...ids); return ids.map((i) => st(i)); } });
    expect(seen).toEqual(['ok1']);
  });

  it('a failed request leaves state unchanged and does not throw', async () => {
    const v = uploaded('z1');
    await expect(pollProcessing(db, { ...tokens, fetchVideos: async () => { throw new Error('network down'); } })).resolves.toBeUndefined();
    expect(proc(v).s).toBe('NOT_CHECKED');
  });

  it('a revoked account is skipped while other accounts are still checked', async () => {
    const other = Number(db.prepare("INSERT INTO youtube_accounts(channel_id,channel_title,confirmed,is_enabled,secret_ref) VALUES('UC2','C2',1,1,'r2')").run().lastInsertRowid);
    const a = uploaded('a9', { account: accountId });
    const b = uploaded('b9', { account: other });
    await pollProcessing(db, {
      getToken: async (id) => { if (id === accountId) throw new AuthRevokedError(); return 'AT'; },
      fetchVideos: async (ids) => ids.map((i) => st(i)),
    });
    expect(proc(a).s).toBe('NOT_CHECKED');
    expect(proc(b).s).toBe('READY');
  });
});

describe('real HTTP fetch against the fake YouTube', () => {
  let yt: FakeYouTube;
  beforeEach(async () => {
    yt = await startFakeYouTube();
  });
  afterEach(() => yt.close());

  it('calls videos.list with ids, parts and a bearer token, and parses the statuses', async () => {
    yt.statusOf = (id) => (id === 'live1' ? { uploadStatus: 'processed', privacyStatus: 'public', processingStatus: 'succeeded' } : id === 'bad1' ? { uploadStatus: 'rejected', rejectionReason: 'copyright', privacyStatus: 'private' } : null);
    const fetchVideos = makeFetchVideos({ baseUrl: yt.baseUrl });
    const items = await fetchVideos(['live1', 'bad1', 'missing1'], 'AT');
    expect(yt.statusRequests).toEqual(['live1,bad1,missing1']);
    expect(items.map((i) => i.id).sort()).toEqual(['bad1', 'live1']);
    expect(items.find((i) => i.id === 'bad1')).toMatchObject({ uploadStatus: 'rejected', rejectionReason: 'copyright' });
  });

  it('end to end through pollProcessing and the monitor timer', async () => {
    const v = uploaded('live1');
    const monitor = startStatusMonitor({ ...tokens, db, fetchVideos: makeFetchVideos({ baseUrl: yt.baseUrl }) }, 20);
    const t0 = Date.now();
    while (proc(v).s !== 'READY' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    monitor.stop();
    expect(proc(v)).toMatchObject({ s: 'READY', p: 'public' });
    expect(isPublished(db, v)).toBe(true);
  });

  it('an HTTP error from YouTube is raised so pollProcessing can skip the round', async () => {
    const fetchVideos = makeFetchVideos({ baseUrl: 'http://127.0.0.1:1' });
    await expect(fetchVideos(['x'], 'AT')).rejects.toThrow();
  });
});
