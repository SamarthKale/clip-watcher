import { useState } from 'react';
import { errorText } from '../api';
import { Button, Card, Field, Notice, PageHeader, inputCls, selectCls } from '../components/ui';
import { pipe, usePipelinePoll, type VodData } from '../pipeline';

const STATUS: Record<string, string> = {
  pending: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  running: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  failed: 'bg-red-500/15 text-red-600 dark:text-red-300',
  filtered: 'bg-zinc-500/10 text-zinc-500',
};

export function Vod() {
  const data = usePipelinePoll(() => pipe.get<VodData>('vod'), 3000);
  const [links, setLinks] = useState('');
  const [shorts, setShorts] = useState(5);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [w, setW] = useState({ platform: 'twitch', channel: '', keyword: '', hours: 36 });
  const d = data.data;

  const add = async () => {
    setMsg(null);
    try {
      const r = await pipe.post<{ ok: boolean; message: string; results?: { url: string; error?: string }[] }>('vod/add', { url: links, shorts });
      const bad = (r.results ?? []).filter((x) => x.error);
      setMsg({ tone: r.ok ? 'info' : 'error', text: [r.message, ...bad.map((b) => `${b.url}: ${b.error}`)].join('\n') });
      if (r.ok) setLinks('');
      data.reload();
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); }
  };
  const retry = async (id: number) => { await pipe.post('vod/retry', { id }); data.reload(); };
  const watchAdd = async () => {
    try {
      const r = await pipe.post<{ ok: boolean; message: string }>('watch/add', w);
      setMsg({ tone: r.ok ? 'info' : 'error', text: r.ok ? `Watching ${w.platform}:${w.channel}` : r.message });
      if (r.ok) setW({ ...w, channel: '', keyword: '' });
      data.reload();
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); }
  };
  const watchRemove = async (platform: string, channel: string) => { await pipe.post('watch/remove', { platform, channel }); data.reload(); };
  const check = async () => {
    try {
      const r = await pipe.post<{ queued: number; filtered: number; errors: string[] }>('watch/check');
      setMsg({ tone: r.errors.length ? 'error' : 'info', text: `${r.queued} new stream(s) queued, ${r.filtered} skipped${r.errors.length ? '\n' + r.errors.join('\n') : ''}` });
      data.reload();
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); }
  };

  return (
    <div>
      <PageHeader title="Add a video" subtitle="Paste any video link: a finished stream, a podcast episode, any YouTube video, or another site yt-dlp supports. Spikecut downloads it, finds the best moments and edits them into Shorts by itself." />
      {data.offline && <Notice tone="warn" className="mb-4">Spikecut's pipeline isn't reachable right now. Links you add are worked as soon as it is.</Notice>}
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'} className="mb-4"><span className="whitespace-pre-wrap">{msg.text}</span></Notice>}

      <Card className="mb-4 space-y-3">
        <Field label="Links" hint="One or several, separated by spaces or new lines. YouTube videos, Shorts, streams and podcasts; Twitch and Kick past broadcasts or clips; most other video sites. Playlists, channels and live streams aren't links to one video.">
          <textarea className={`${inputCls} h-24 font-mono text-xs`} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="Video links" />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Shorts per video" hint="At most this many Shorts from each link (1-20).">
            <input className={`${inputCls} w-24`} type="number" min={1} max={20} value={shorts} aria-label="Shorts per video"
              onChange={(e) => setShorts(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
          </Field>
          <Button variant="primary" onClick={add} disabled={!links.trim()}>Add and start</Button>
        </div>
        <p className="text-xs text-zinc-500">Work starts by itself; you don't need to press Start or pick a channel. A stream with a chat replay is clipped where chat spiked. Anything else is transcribed in full and Claude picks its best moments (podcasts and talking videos get a follow-the-speaker edit). Long videos take a while: the whole thing is downloaded and transcribed first.</p>
      </Card>

      <Card className="mb-4">
        <h2 className="mb-2 font-semibold">Queue</h2>
        {!d?.jobs.length ? <div className="py-6 text-center text-sm text-zinc-500">No links yet.</div> : (
          <table className="w-full text-sm"><tbody>
            {d.jobs.map((j) => (
              <tr key={j.id} className="border-t border-zinc-200/60 align-top first:border-0 dark:border-zinc-700/60">
                <td className="py-2 pr-2"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[j.status] ?? STATUS.pending}`}>{j.status}</span></td>
                <td className="py-2 pr-2"><div className="break-all">{j.url}</div>
                  <div className="text-xs text-zinc-500">{j.note ?? ''}{j.status === 'done' ? ` · ${j.events} moment(s)` : ''}{` · up to ${j.max_shorts ?? 5} Shorts`}{j.source.startsWith('watch') ? ` · from ${j.source.slice(6)}` : ''}</div>
                  {j.error && <div className="mt-1 text-xs text-red-500">{j.error}</div>}</td>
                <td className="py-2 text-right">{j.status === 'failed' && <Button className="!px-2.5 !py-1 text-xs" onClick={() => retry(j.id)}>Retry</Button>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>

      <Card>
        <div className="mb-1 flex items-center justify-between"><h2 className="font-semibold">Streamer watch list</h2><Button className="!px-3 !py-1 text-xs" onClick={check}>Check now</Button></div>
        <p className="mb-3 text-xs text-zinc-500">New finished streams from these channels are clipped automatically while the pipeline runs (checked every hour). An optional title word keeps it to the streams you want; empty takes all.</p>
        <div className="mb-3 grid gap-2 sm:grid-cols-[8rem_1fr_1fr_7rem_auto]">
          <select className={selectCls} value={w.platform} onChange={(e) => setW({ ...w, platform: e.target.value })} aria-label="Platform"><option value="twitch">Twitch</option><option value="youtube">YouTube</option><option value="kick">Kick</option></select>
          <input className={inputCls} placeholder="channel (name or @handle)" value={w.channel} onChange={(e) => setW({ ...w, channel: e.target.value })} aria-label="Channel" />
          <input className={inputCls} placeholder="title must contain (optional)" value={w.keyword} onChange={(e) => setW({ ...w, keyword: e.target.value })} aria-label="Title filter" />
          <input className={inputCls} type="number" min={1} max={720} value={w.hours} onChange={(e) => setW({ ...w, hours: Number(e.target.value) })} aria-label="Hours back" title="Only streams newer than this many hours" />
          <Button variant="primary" onClick={watchAdd} disabled={!w.channel.trim()}>Watch</Button>
        </div>
        {!d?.watch.length ? <div className="py-4 text-center text-sm text-zinc-500">No channels on the list.</div> : (
          <ul className="divide-y divide-zinc-200/60 text-sm dark:divide-zinc-700/60">
            {d.watch.map((x) => (
              <li key={x.id} className="flex items-center justify-between py-2">
                <span><b>{x.platform}:{x.channel}</b> <span className="text-zinc-500">· {x.keyword ? `title has “${x.keyword}”` : 'all streams'} · last {x.lookback_hours} h{x.last_checked ? ` · checked ${new Date(x.last_checked * 1000).toLocaleTimeString()}` : ''}</span></span>
                <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => watchRemove(x.platform, x.channel)}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
