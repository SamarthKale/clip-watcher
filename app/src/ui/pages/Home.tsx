import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api, errorText } from '../api';
import { AnimatedNumber, Button, Card, Icon, LiveDot, Notice, PageHeader } from '../components/ui';
import { fmtClock, pipe, usePipelinePoll, type ChatState, type LogLine, type PipelineState, type SetupStatus } from '../pipeline';
import { SpikeTable } from './Spikes';

const CHANNEL_KEY = 'clipper-channel';

/** Claude edits the Shorts. Set up once: Anthropic's official installer, then the user's own sign-in. */
function ClaudeSetup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'start' | 'installing' | 'signin'>('start');
  const [err, setErr] = useState('');
  const run = async (what: 'install' | 'signin') => {
    setErr('');
    try {
      await api.post('/api/claude/' + what);
      setStep(what === 'install' ? 'installing' : 'signin');
      if (what === 'signin') setTimeout(onDone, 4000);
    } catch (e) { setErr(errorText(e)); }
  };
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold"><Icon name="scissors" className="h-4 w-4 text-indigo-600" />Set up Claude</div>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {step === 'start' && <>Claude is the editor that turns each spike into a finished Short. Setting it up installs Claude Code with Anthropic's official installer, then you sign in with your own Claude account.</>}
            {step === 'installing' && <>A window opened and is installing Claude Code. When it says Done, press <b>Sign in to Claude</b>.</>}
            {step === 'signin' && <>Claude opened in its own window. Follow its steps to sign in, then close it. Spikecut finds Claude by itself.</>}
          </p>
          {err && <p className="mt-1 text-sm text-red-600">{err}</p>}
        </div>
        <div className="flex gap-2">
          {step === 'start' && <Button variant="primary" onClick={() => run('install')}>Set up Claude</Button>}
          <Button onClick={() => run('signin')}>Sign in to Claude</Button>
        </div>
      </div>
    </Card>
  );
}

function Chip({ tone, pulse, children }: { tone: 'ok' | 'wait' | 'live' | 'bad'; pulse?: boolean; children: React.ReactNode }) {
  const t = {
    ok: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
    wait: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
    live: 'bg-coral-500/12 text-coral-600 dark:text-coral-400',
    bad: 'bg-red-500/15 text-red-600 dark:text-red-300',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold ${t}`}>
      {pulse ? <LiveDot className="" /> : <span className="h-2 w-2 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

function Stat({ icon, value, label, accent }: { icon: string; value: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <Card lift className="group flex flex-col gap-1">
      <span className={`mb-2 grid h-9 w-9 place-items-center rounded-xl transition-transform duration-300 group-hover:scale-110 ${accent ? 'bg-coral-500/12 text-coral-600' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300'}`}><Icon name={icon} className="h-4 w-4" /></span>
      <div className="font-display text-3xl font-semibold leading-none tracking-[-0.02em]">{typeof value === 'number' ? <AnimatedNumber value={value} /> : value}</div>
      <div className="text-sm text-zinc-500">{label}</div>
    </Card>
  );
}

function ChatChart({ chat }: { chat: ChatState }) {
  const b = chat.buckets;
  const W = 600, H = 150;
  const max = Math.max(10, chat.threshold * 1.15, ...b);
  const bw = (W - 8) / Math.max(1, b.length);
  const y = (v: number) => H - ((H - 12) * v) / max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-3 h-36 w-full" role="img" aria-label="Chat messages per 10 seconds, last 10 minutes">
      {b.map((v, i) => (
        <motion.rect
          key={i} x={4 + i * bw + 1} width={Math.max(1, bw - 2)} rx={2}
          className={chat.threshold > 0 && v >= chat.threshold ? 'fill-coral-500' : 'fill-indigo-400'}
          opacity={chat.threshold > 0 && v >= chat.threshold ? 1 : 0.7}
          initial={{ y: H, height: 0 }}
          animate={{ y: y(v), height: H - y(v) }}
          transition={{ type: 'spring', stiffness: 170, damping: 24, delay: Math.min(i * 0.008, 0.4) }}
        />
      ))}
      {chat.threshold > 0 && <line x1={0} x2={W} y1={y(chat.threshold)} y2={y(chat.threshold)} style={{ stroke: 'var(--color-coral-500)' }} strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function ActivityChart({ data }: { data: PipelineState['activity'] }) {
  const W = 700, H = 130, pad = 18;
  const bw = (W - pad * 2) / Math.max(1, data.length);
  const max = Math.max(4, ...data.flatMap((d) => [d.spikes, d.shorts]));
  const h = (v: number) => ((H - 36) * v) / max;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-32 w-full" role="img" aria-label="Spikes and Shorts per day, last 14 days">
      {data.map((d, i) => (
        <g key={d.date}>
          <rect x={pad + i * bw + bw * 0.12} y={H - 24 - h(d.spikes)} width={bw * 0.36} height={h(d.spikes)} rx={2} className="fill-zinc-400/50" />
          <rect x={pad + i * bw + bw * 0.5} y={H - 24 - h(d.shorts)} width={bw * 0.36} height={h(d.shorts)} rx={2} className="fill-indigo-500" />
          {(i % 2 === 1 || i === data.length - 1) && <text x={pad + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" className="fill-zinc-500">{i === data.length - 1 ? 'Today' : d.date.slice(5)}</text>}
        </g>
      ))}
    </svg>
  );
}

export function MiniLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const off = useRef<Record<string, number> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const q = off.current ? `?offsets=${encodeURIComponent(JSON.stringify(off.current))}` : '';
        const r = await pipe.get<{ offsets: Record<string, number>; lines: LogLine[] }>('logs', q);
        if (!live) return;
        off.current = r.offsets;
        if (r.lines.length) setLines((l) => [...l, ...r.lines].slice(-40));
      } catch { /* pipeline offline: nothing to show */ }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => { live = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  return (
    <div ref={box} className="mt-2 h-52 overflow-auto rounded-lg bg-zinc-900/90 p-3 font-mono text-xs leading-5 text-zinc-200 ring-1 ring-black/5">
      {lines.length === 0 ? <span className="text-zinc-500">No log lines yet. Start watching a channel.</span> : lines.map((l, i) => (
        <div key={i} className={l.level === 'ERROR' ? 'text-red-300' : l.level === 'WARNING' ? 'text-amber-200' : /SPIKE/.test(l.msg) ? 'text-emerald-300' : ''}>
          <span className="text-zinc-500">{l.ts.slice(11)}</span> <span className="text-amber-300">{l.stage}</span> {l.msg}
        </div>
      ))}
    </div>
  );
}

export function Home() {
  const [channel, setChannel] = useState(() => localStorage.getItem(CHANNEL_KEY) ?? '');
  const [input, setInput] = useState(channel ? `https://www.twitch.tv/${channel}` : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const q = channel ? `?channel=${encodeURIComponent(channel)}` : '';
  const state = usePipelinePoll(() => pipe.get<PipelineState>('state', q), 3000);
  const chat = usePipelinePoll(() => pipe.get<ChatState>('chat', q), 2000);
  const setup = usePipelinePoll(() => pipe.get<SetupStatus>('setup'), 30_000);
  const st = state.data;

  useEffect(() => {
    if (!channel && st?.channel) { setChannel(st.channel); setInput(`https://www.twitch.tv/${st.channel}`); }
  }, [st, channel]);

  const start = async () => {
    if (!input.trim()) return setMsg({ tone: 'error', text: 'Enter a Twitch channel first.' });
    setBusy(true); setMsg(null);
    try {
      const r = await pipe.post<{ ok: boolean; message: string; channel: string }>('start', { channel: input });
      if (!r.ok) throw new Error(r.message);
      setChannel(r.channel); localStorage.setItem(CHANNEL_KEY, r.channel);
      setMsg({ tone: 'info', text: r.message === 'started' ? `Watching ${r.channel}.` : r.message });
      state.reload();
    } catch (e) { setMsg({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { const r = await pipe.post<{ message: string }>('stop'); setMsg({ tone: 'info', text: r.message === 'stopping' ? 'Stopping. The recorder closes cleanly.' : r.message }); setTimeout(state.reload, 1500); }
    catch (e) { setMsg({ tone: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };

  const p = st?.pipeline;
  return (
    <div>
      <PageHeader title="Home" subtitle={st?.channel ? (st.live ? `Recording ${st.channel} since ${fmtClock(st.live_since)}.` : `Channel: ${st.channel}.`) + ` ${st.stats.shorts_total} Shorts made in total.` : 'Paste a Twitch channel and press Start watching.'} />

      {setup.data?.tools.some((t) => t.name === 'claude' && !t.ok) && <ClaudeSetup onDone={setup.reload} />}
      {setup.data && (setup.data.tools.some((t) => !t.ok && t.name !== 'claude') || (setup.data.backup_drive && !setup.data.backup_drive.ok)) && (
        <Notice tone="warn" className="mb-4">
          <b>Setup needed.</b>
          <ul className="mt-1 list-disc pl-5">
            {setup.data.tools.filter((t) => !t.ok && t.name !== 'claude').map((t) => <li key={t.name}><b>{t.name}</b> was not found (needed for {t.needed_for}). Get it from {t.hint}.</li>)}
            {setup.data.backup_drive && !setup.data.backup_drive.ok && <li>The backup drive {setup.data.backup_drive.path} is not available: {setup.data.backup_drive.why}</li>}
          </ul>
        </Notice>
      )}
      {state.offline && <Notice tone="warn" className="mb-4">The clipping pipeline is not running. Restart the app, or run <code>python -m clipwatcher ui</code> from the project folder.</Notice>}
      {msg && <Notice tone={msg.tone === 'error' ? 'error' : 'info'} className="mb-4">{msg.text}</Notice>}

      <Card className="mb-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Icon name="chart" className="h-4 w-4 text-indigo-600" />Watch a Twitch channel</div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="min-w-60 flex-1 rounded-xl border border-zinc-300 bg-white/70 px-4 py-2.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/15 dark:border-zinc-700"
            placeholder="https://www.twitch.tv/name or just the channel name"
            value={input} onChange={(e) => setInput(e.target.value)} disabled={!!p?.owned}
            onKeyDown={(e) => { if (e.key === 'Enter') void start(); }} aria-label="Twitch channel"
          />
          {p?.owned ? <Button variant="danger" className="!px-4 !py-2.5" onClick={stop} disabled={busy}>Stop</Button> : <Button variant="primary" className="!px-4 !py-2.5" onClick={start} disabled={busy}><Icon name="play" className="h-3.5 w-3.5" />Start watching</Button>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Chip tone={p?.running ? 'ok' : 'wait'} pulse={p?.running}>{p?.running ? 'Pipeline running' : 'Pipeline off'}</Chip>
          <Chip tone={st?.live ? 'live' : 'wait'} pulse={st?.live}>{st?.live ? 'Live and recording' : p?.running ? 'Waiting for the stream' : 'Offline'}</Chip>
          {p?.running && !p.owned && <span className="text-xs text-zinc-500">Started outside this window. Stop it with Ctrl+C where it runs.</span>}
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon="play" accent={!!st?.live} value={st?.live ? <span className="inline-flex items-center gap-2.5 text-coral-600"><LiveDot />Live</span> : p?.running ? 'Waiting' : 'Offline'} label="Stream" />
        <Stat icon="sparkles" value={st?.stats.spikes_today ?? 0} label="Spikes today" />
        <Stat icon="film" value={st?.stats.shorts_today ?? 0} label="Shorts today" />
        <Stat icon="clock" value={(st?.stats.queue.waiting ?? 0) + (st?.stats.queue.editing ?? 0)} label={st?.stats.queue.editing ? `Editing now, ${st.stats.queue.waiting} waiting` : 'In edit queue'} />
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <div className="flex items-start justify-between gap-2">
            <div><h2 className="font-semibold">Chat, live</h2><p className="text-xs text-zinc-500">Messages per 10 s over the last 10 minutes. A spike is the dashed line.</p></div>
            <Chip tone={chat.data?.connected ? 'ok' : 'wait'} pulse={chat.data?.connected}>{chat.data?.connected ? 'Chat connected' : 'Not connected'}</Chip>
          </div>
          {chat.data ? <ChatChart chat={chat.data} /> : <div className="h-36" />}
          {chat.data && chat.data.buckets.length > 0 && <div className="mt-1 text-xs text-zinc-500">now {chat.data.buckets.at(-1)}/10 s · normal {chat.data.baseline} · spike at {chat.data.threshold}</div>}
        </Card>
        <Card>
          <h2 className="font-semibold">Chat feed</h2>
          <p className="mb-2 text-xs text-zinc-500">Read-only. This is what the detector sees.</p>
          <div className="flex max-h-56 flex-col gap-0.5 overflow-auto text-sm">
            {chat.data?.messages.length ? chat.data.messages.map((m, i) => <div key={i}><b className="text-indigo-600 dark:text-indigo-300">{m.name}</b> {m.text}</div>) : <div className="py-8 text-center text-zinc-500">Chat appears when the pipeline is running.</div>}
          </div>
        </Card>
      </div>

      <Card className="mb-4">
        <div className="flex items-start justify-between"><div><h2 className="font-semibold">Activity</h2><p className="text-xs text-zinc-500">Last 14 days</p></div>
          <div className="text-right text-sm"><b>{st?.activity.reduce((s, d) => s + d.spikes, 0) ?? 0}</b> <span className="text-zinc-500">spikes</span> &nbsp; <b>{st?.activity.reduce((s, d) => s + d.shorts, 0) ?? 0}</b> <span className="text-zinc-500">Shorts made</span></div></div>
        {st && <ActivityChart data={st.activity} />}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between"><h2 className="font-semibold">Recent spikes</h2><a className="text-xs font-medium text-indigo-600 hover:underline" href="#/spikes">See all</a></div>
          <SpikeTable rows={(st?.events ?? []).slice(0, 6)} compact onChanged={state.reload} />
        </Card>
        <Card>
          <div className="flex items-center justify-between"><h2 className="font-semibold">Live log</h2><a className="text-xs font-medium text-indigo-600 hover:underline" href="#/log">Open</a></div>
          <MiniLog />
        </Card>
      </div>
    </div>
  );
}
