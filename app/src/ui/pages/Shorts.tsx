import { useRef } from 'react';
import { Button, Card, EmptyState, Notice, PageHeader } from '../components/ui';
import { pipe, usePipelinePoll, type ShortRow } from '../pipeline';
import { errorText } from '../api';

const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

export function Shorts() {
  const playing = useRef(false);
  const list = usePipelinePoll(async () => {
    const r = await pipe.get<ShortRow[]>('shorts');
    return r;
  }, 8000);
  const open = async (id: string) => { try { await pipe.post('open', { event_id: id }); } catch (e) { alert(errorText(e)); } };
  const rows = list.data ?? [];
  return (
    <div>
      <PageHeader title="Shorts" subtitle={rows.length ? `${rows.length} finished Short${rows.length > 1 ? 's' : ''}, newest first. Approve and upload them under Review & publish.` : 'Finished Shorts appear here as soon as an edit finishes.'}>
        <a className="text-sm font-medium text-indigo-600 hover:underline" href="#/library">Review &amp; publish →</a>
      </PageHeader>
      {list.offline && <Notice tone="warn" className="mb-4">The clipping pipeline is not running, so Shorts can't be played right now.</Notice>}
      {!rows.length && !list.offline && <Card><EmptyState icon="film" title="No Shorts yet">They appear here as soon as an edit finishes.</EmptyState></Card>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((s) => (
          <Card key={s.event_id} lift className="overflow-hidden !p-0">
            <video
              controls preload="metadata" className="aspect-[9/16] max-h-[28rem] w-full bg-zinc-950 object-contain"
              poster={s.has_thumb ? `/api/pipeline-media/${s.event_id}/thumbnail.jpg` : undefined}
              src={`/api/pipeline-media/${s.event_id}/short.mp4`}
              onPlay={() => { playing.current = true; }} onPause={() => { playing.current = false; }}
            />
            <div className="space-y-2 p-3">
              <div className="font-semibold leading-snug">{s.title}</div>
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{s.duration}s</span>
                {s.score != null && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">score {s.score}</span>}
                {s.moment && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{s.moment}</span>}
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{s.size_mb} MB</span>
              </div>
              <div className="text-xs text-zinc-500">{s.channel} · {s.date} · made {ago(s.made)}</div>
              <Button className="!px-2.5 !py-1 text-xs" onClick={() => open(s.event_id)}>Show folder</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
