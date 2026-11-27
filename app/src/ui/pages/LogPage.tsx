import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, PageHeader } from '../components/ui';
import { pipe, type LogLine } from '../pipeline';

export function LogPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [stage, setStage] = useState('all');
  const [errOnly, setErrOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [offline, setOffline] = useState(false);
  const off = useRef<Record<string, number> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const q = off.current ? `?offsets=${encodeURIComponent(JSON.stringify(off.current))}` : '';
        const r = await pipe.get<{ offsets: Record<string, number>; lines: LogLine[] }>('logs', q);
        if (!live) return;
        setOffline(false);
        off.current = r.offsets;
        if (r.lines.length) setLines((l) => [...l, ...r.lines].slice(-2500));
      } catch { if (live) setOffline(true); }
    };
    void tick();
    const t = setInterval(tick, 1500);
    return () => { live = false; clearInterval(t); };
  }, []);

  const stages = useMemo(() => ['all', ...[...new Set(lines.map((l) => l.stage))].sort()], [lines]);
  const shown = useMemo(() => lines.filter((l) => (stage === 'all' || l.stage === stage) && (!errOnly || /WARNING|ERROR|CRITICAL/.test(l.level))).slice(-700), [lines, stage, errOnly]);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [shown, follow]);

  return (
    <div>
      <PageHeader title="Live log" subtitle="Everything the pipeline prints: recorder, chat, detector, extractor, transcriber, editor, storage." />
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {stages.map((s) => (
          <button key={s} onClick={() => setStage(s)} className={`rounded-full border px-3 py-1 text-xs ${s === stage ? 'border-transparent bg-indigo-500/20 font-semibold text-indigo-600 dark:text-indigo-300' : 'border-zinc-300/60 text-zinc-500 dark:border-zinc-700'}`}>{s}</button>
        ))}
        <span className="flex-1" />
        <Button variant={errOnly ? 'soft' : 'default'} className="!px-3 !py-1 text-xs" onClick={() => setErrOnly(!errOnly)}>Errors &amp; warnings only</Button>
        <Button variant={follow ? 'soft' : 'default'} className="!px-3 !py-1 text-xs" onClick={() => setFollow(!follow)}>Follow</Button>
        <Button className="!px-3 !py-1 text-xs" onClick={() => setLines([])}>Clear</Button>
      </div>
      <div
        ref={box}
        onWheel={() => { const el = box.current; if (el && follow && el.scrollTop + el.clientHeight < el.scrollHeight - 40) setFollow(false); }}
        className="h-[calc(100vh-17rem)] min-h-72 overflow-auto rounded-xl bg-black/45 p-4 font-mono text-[12.5px] leading-6 text-zinc-200"
        aria-label="Pipeline log"
      >
        {shown.length === 0 && <div className="text-zinc-500">{offline ? 'The pipeline is not running.' : 'No log lines yet. Start watching a channel to see the pipeline work.'}</div>}
        {shown.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${l.level === 'ERROR' || l.level === 'CRITICAL' ? 'text-red-300' : l.level === 'WARNING' ? 'text-amber-200' : /SPIKE/.test(l.msg) ? 'font-semibold text-emerald-300' : ''}`}>
            <span className="text-zinc-500">{l.ts.slice(11)}</span> <span className="text-amber-300">{l.stage}</span> {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
