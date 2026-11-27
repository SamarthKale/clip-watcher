import { useState } from 'react';
import { errorText } from '../api';
import { Button, Card, Field, Notice, PageHeader, inputCls } from '../components/ui';
import { fmtBytes, pipe, usePipelinePoll, type StorageItem, type StoragePlan, type StorageSummary } from '../pipeline';

const KINDS: { id: string; label: string; hint: string }[] = [
  { id: 'recording', label: 'Recordings', hint: 'full stream files' },
  { id: 'raw_backup', label: 'Raw clip backups', hint: 'the 2.5-minute cuts on your backup drive' },
  { id: 'raw_clip', label: 'Raw clips (working copies)', hint: 'only once backed up' },
  { id: 'short', label: 'Edited Shorts', hint: 'finished videos in Edited Clips' },
  { id: 'library', label: 'Library folders', hint: 'upload-ready copies' },
];

export function Storage() {
  const sum = usePipelinePoll(() => pipe.get<StorageSummary>('storage'), 15_000);
  const [days, setDays] = useState(30);
  const [kinds, setKinds] = useState<string[]>(KINDS.map((k) => k.id));
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [over, setOver] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const s = sum.data;

  const preview = async () => {
    setMsg(null); setBusy(true);
    try {
      const r = await pipe.post<StoragePlan & { ok: boolean; message?: string }>('storage/plan', { older_than_days: days, kinds });
      if (!r.ok) throw new Error(r.message ?? 'Could not build the preview');
      setPlan(r); setPick(new Set(r.delete.map((i) => i.id))); setOver(new Set());
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };

  const chosen = plan ? [...plan.delete.filter((i) => pick.has(i.id)), ...plan.blocked.filter((i) => over.has(i.id))] : [];
  const bytes = chosen.reduce((n, i) => n + i.size, 0);

  const run = async () => {
    if (!plan || chosen.length === 0) return;
    const forced = plan.blocked.filter((i) => over.has(i.id));
    const text = `Permanently delete ${chosen.length} item(s), freeing ${fmtBytes(bytes)}?` +
      (forced.length ? `\n\n${forced.length} of them are NOT backed up or uploaded yet and cannot be recovered:\n- ${forced.slice(0, 6).map((i) => i.label).join('\n- ')}` : '') + '\n\nThis cannot be undone.';
    if (!window.confirm(text)) return;
    setBusy(true);
    try {
      const r = await pipe.post<{ deleted: { label: string }[]; refused: { label?: string; reason: string }[]; freed_bytes: number }>('storage/run', { ids: chosen.map((i) => i.id), override_ids: [...over] });
      setMsg({ tone: r.refused.length ? 'error' : 'info', text: `Deleted ${r.deleted.length} item(s), freed ${fmtBytes(r.freed_bytes)}.` + (r.refused.length ? `\n${r.refused.length} refused:\n` + r.refused.map((x) => `${x.label ?? ''}: ${x.reason}`).join('\n') : '') });
      setPlan(null); sum.reload();
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); setter(n); };
  const row = (i: StorageItem, checked: boolean, onChange: () => void, danger = false) => (
    <label key={i.id} className="flex cursor-pointer items-start gap-3 border-t border-zinc-200/60 py-2 first:border-0 dark:border-zinc-700/60">
      <input type="checkbox" className="mt-1" checked={checked} onChange={onChange} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{i.label}</span>
        <span className="block text-xs text-zinc-500">{KINDS.find((k) => k.id === i.kind)?.label} · {Math.round(i.age_days)} days old · {i.state}</span>
        {danger && <span className="block text-xs text-amber-500">{i.reason}</span>}
      </span>
      <span className="text-sm text-zinc-500">{fmtBytes(i.size)}</span>
    </label>
  );

  const total = s?.total_bytes ?? 0;
  return (
    <div>
      <PageHeader title="Storage" subtitle="See what takes space and clean up old clips and recordings. Nothing is deleted without a preview and your confirmation." />
      {sum.offline && <Notice tone="warn" className="mb-4">The clipping pipeline is not running, so storage can't be read right now.</Notice>}
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'} className="mb-4"><span className="whitespace-pre-wrap">{msg.text}</span></Notice>}

      {s && (
        <Card className="mb-4">
          <div className="mb-3 flex items-baseline justify-between"><h2 className="font-semibold">What's using space</h2><span className="text-sm text-zinc-500">{fmtBytes(total)} in total</span></div>
          <div className="mb-3 flex h-3 overflow-hidden rounded-full bg-zinc-500/15">
            {KINDS.map((k, i) => <div key={k.id} title={`${k.label}: ${fmtBytes(s.by_kind[k.id] ?? 0)}`} style={{ width: `${total ? ((s.by_kind[k.id] ?? 0) / total) * 100 : 0}%` }} className={['bg-indigo-500', 'bg-violet-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400'][i]} />)}
          </div>
          <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {KINDS.map((k, i) => (
              <div key={k.id} className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${['bg-indigo-500', 'bg-violet-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400'][i]}`} />{k.label}<span className="text-xs text-zinc-500">{k.hint}</span><span className="ml-auto font-medium">{fmtBytes(s.by_kind[k.id] ?? 0)}</span></div>
            ))}
          </div>
          {Object.entries(s.disks).length > 0 && <div className="mt-3 border-t border-zinc-200/60 pt-3 text-xs text-zinc-500 dark:border-zinc-700/60">{Object.entries(s.disks).map(([n, d]) => <span key={n} className="mr-4">{n === 'project' ? 'Project drive' : 'Backup drive'} ({d.path.slice(0, 3)}): {fmtBytes(d.free_bytes)} free of {fmtBytes(d.total_bytes)}</span>)}</div>}
        </Card>
      )}

      <Card className="mb-4 space-y-4">
        <h2 className="font-semibold">Clean up</h2>
        <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
          <Field label="Older than (days)"><input type="number" min={0} max={3650} className={inputCls} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Older than days" /></Field>
          <div>
            <div className="mb-1 text-sm font-medium">What to include</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {KINDS.map((k) => <label key={k.id} className="flex items-center gap-1.5"><input type="checkbox" checked={kinds.includes(k.id)} onChange={() => setKinds(kinds.includes(k.id) ? kinds.filter((x) => x !== k.id) : [...kinds, k.id])} />{k.label}</label>)}
            </div>
          </div>
        </div>
        <Button variant="primary" onClick={preview} disabled={busy || kinds.length === 0}>Preview what would be deleted</Button>
        <p className="text-xs text-zinc-500">Recordings are only offered once every clip from them is cut, backed up and uploaded or discarded. Shorts are only offered once uploaded or discarded. Anything else is listed as protected.</p>
      </Card>

      {plan && (
        <>
          <Card className="mb-4">
            <div className="mb-1 flex items-center justify-between"><h2 className="font-semibold">Safe to delete ({plan.delete.length})</h2><span className="text-sm text-zinc-500">{fmtBytes(plan.free_bytes)}</span></div>
            {plan.delete.length === 0 ? <div className="py-4 text-sm text-zinc-500">Nothing older than {plan.older_than_days} days is ready to delete.</div> : <div>{plan.delete.map((i) => row(i, pick.has(i.id), () => toggle(pick, setPick, i.id)))}</div>}
          </Card>
          {plan.blocked.length > 0 && (
            <Card className="mb-4">
              <h2 className="mb-1 font-semibold">Protected ({plan.blocked.length})</h2>
              <p className="mb-2 text-xs text-zinc-500">These are not ready: they are not uploaded, not backed up, or still being processed. Some can be forced; that cannot be undone.</p>
              {plan.blocked.map((i) => i.overridable
                ? row(i, over.has(i.id), () => toggle(over, setOver, i.id), true)
                : (
                  <div key={i.id} className="flex items-start gap-3 border-t border-zinc-200/60 py-2 first:border-0 dark:border-zinc-700/60">
                    <span className="mt-1 text-zinc-400">🔒</span>
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{i.label}</span><span className="block text-xs text-zinc-500">{i.reason}</span></span>
                    <span className="text-sm text-zinc-500">{fmtBytes(i.size)}</span>
                  </div>
                ))}
            </Card>
          )}
          <div className="flex items-center gap-3">
            <Button variant="danger" onClick={run} disabled={busy || chosen.length === 0}>Delete {chosen.length} selected ({fmtBytes(bytes)})</Button>
            <Button variant="ghost" onClick={() => setPlan(null)}>Cancel</Button>
          </div>
        </>
      )}
    </div>
  );
}
