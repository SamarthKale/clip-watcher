import { useState } from 'react';
import { errorText } from '../api';
import { Button, Card, EmptyState, Notice, PageHeader } from '../components/ui';
import { fmtClock, pipe, usePipelinePoll, type PipelineState, type SpikeRow } from '../pipeline';

const TONE: Record<SpikeRow['tone'], string> = {
  ok: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  bad: 'bg-red-500/15 text-red-600 dark:text-red-300',
  live: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
  wait: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
};

export function SpikeTable({ rows, compact, onChanged }: { rows: SpikeRow[]; compact?: boolean; onChanged: () => void }) {
  const [note, setNote] = useState('');
  if (!rows.length) return <div className="py-8 text-center text-sm text-zinc-500">No spikes yet. They appear when chat jumps well above its normal pace.</div>;
  const act = async (kind: 'skip' | 'retry', id: string) => {
    try { const r = await pipe.post<{ message: string }>(kind, { event_id: id }); setNote(r.message); } catch (e) { setNote(errorText(e)); }
    onChanged();
  };
  return (
    <div>
      {note && <div className="mb-2 text-xs text-zinc-500" role="status">{note}</div>}
      <table className="mt-2 w-full text-sm">
        <thead><tr className="text-left text-xs text-zinc-500"><th className="py-1.5 pr-2 font-medium">Spike</th><th className="py-1.5 pr-2 font-medium">Chat</th><th className="py-1.5 pr-2 font-medium">Status</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-200/60 align-top dark:border-zinc-700/60">
              <td className="py-2 pr-2"><div>{fmtClock(r.spike_ts)}</div><div className="font-mono text-xs text-zinc-500">{r.id}</div></td>
              <td className="py-2 pr-2">{r.messages ?? '–'} msgs<div className="text-xs text-zinc-500">{r.ratio ? `${r.ratio}x of ${r.baseline}` : ''}</div></td>
              <td className="py-2 pr-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[r.tone]}`}>
                  <span className={`h-2 w-2 rounded-full bg-current ${r.tone === 'live' ? 'animate-pulse' : ''}`} />{r.state}
                </span>
                {r.error && !compact && <div className="mt-1 text-xs text-red-500">{r.error}</div>}
              </td>
              <td className="py-2 text-right">
                {r.open_stage && r.tone !== 'live' && (
                  <span className="inline-flex gap-1.5">
                    {(r.failed || /Retrying/.test(r.state)) && <Button className="!px-2.5 !py-1 text-xs" onClick={() => act('retry', r.id)}>Retry</Button>}
                    <Button className="!px-2.5 !py-1 text-xs" onClick={() => act('skip', r.id)}>Skip</Button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Spikes() {
  const state = usePipelinePoll(() => pipe.get<PipelineState>('state'), 3000);
  return (
    <div>
      <PageHeader title="Spikes & clips" subtitle="Every chat spike and where its clip is: cutting, transcribing, editing, done." />
      {state.offline && <Notice tone="warn" className="mb-4">The clipping pipeline is not running.</Notice>}
      <Card>{state.data ? <SpikeTable rows={state.data.events} onChanged={state.reload} /> : <EmptyState icon="list" title="Loading…" />}</Card>
    </div>
  );
}
