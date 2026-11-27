import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { animate, motion, useReducedMotion, type Variants } from 'motion/react';
import { errorText } from '../api';

/* ---------- icons ---------- */
const PATHS: Record<string, string> = {
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  film: 'M4 5h16v14H4zM10 9l5 3-5 3z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  settings: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  check: 'M5 13l4 4L19 7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  x: 'M6 6l12 12M18 6L6 18',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01',
  compass: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 6l-6 6 6 6',
  chart: 'M4 19h16M7 16V10M12 16V6M17 16v-4',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.1 7.9L20 20M8.1 16.1L20 4',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v10a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  youtube: 'M3 8.5A3.5 3.5 0 0 1 6.5 5h11A3.5 3.5 0 0 1 21 8.5v7a3.5 3.5 0 0 1-3.5 3.5h-11A3.5 3.5 0 0 1 3 15.5zM10 9.5v5l4.5-2.5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

export function Icon({ name, className = 'h-4 w-4' }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

/* ---------- basics ---------- */
export function Button({ variant = 'default', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'soft' }) {
  const styles = {
    default: 'border border-zinc-300 bg-white text-zinc-800 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
    primary: 'btn-primary text-white',
    soft: 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900',
    danger: 'border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950',
    ghost: 'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800',
  }[variant];
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition duration-150 active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

/**
 * Entrance animation shared by page content: the page wrapper in App staggers these, so cards and
 * headers rise in one after another. Outside a page (dialogs) they simply show.
 */
export const rise: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 28, mass: 0.8 } },
};

/** A panel. `lift` makes it rise slightly under the pointer (for things you click or play). */
export function Card({ children, className = '', lift = false }: { children: ReactNode; className?: string; lift?: boolean }) {
  return (
    <motion.div
      variants={rise}
      whileHover={lift ? { y: -4, transition: { type: 'spring', stiffness: 400, damping: 26 } } : undefined}
      className={`rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
    >
      {children}
    </motion.div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <motion.div variants={rise} className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-[1.65rem] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </motion.div>
  );
}

/** A number that counts up to its new value (instantly when Windows asks for less motion). */
export function AnimatedNumber({ value, format = (n) => String(Math.round(n)), className = '' }: { value: number; format?: (n: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const fmt = useRef(format);
  fmt.current = format;
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce || from.current === value) { el.textContent = fmt.current(value); from.current = value; return; }
    const c = animate(from.current, value, { duration: 0.9, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => { from.current = v; el.textContent = fmt.current(v); } });
    return () => c.stop();
  }, [value, reduce]);
  return <span ref={ref} className={`tabular ${className}`}>{format(reduce ? value : from.current)}</span>;
}

/** Coral dot with a ripple, for anything live. */
export function LiveDot({ className = 'text-coral-500' }: { className?: string }) {
  return <span className={`live-dot ${className}`} aria-hidden="true" />;
}

const TONE: Record<string, string> = {
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  idle: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
};
const STATUS_TONE: Record<string, string> = {
  VALID: 'good', READY: 'good', APPROVED: 'good', UPLOAD_COMPLETE: 'good', NOT_REQUIRED: 'idle', DONE: 'violet',
  UPLOADING: 'info', ANALYZING: 'info', GENERATING: 'info', PROCESSING: 'info', QUEUED: 'info', WAITING_FOR_STABLE_FILE: 'info', RUNNING: 'violet',
  PENDING: 'warn', RETRY_WAIT: 'warn', STALE: 'warn', UPLOAD_PAUSED: 'warn', BLOCKED_BY_QUOTA: 'warn', BLOCKED_BY_CHANNEL_LIMIT: 'warn', UPLOAD_OUTCOME_UNKNOWN: 'bad', DUPLICATE: 'warn', STATUS_UNKNOWN: 'warn',
  FAILED: 'bad', FAILED_PERMANENTLY: 'bad', INVALID: 'bad', REJECTED: 'bad', UNAVAILABLE: 'bad', CANCELLED: 'idle', SKIPPED: 'idle', NOT_STARTED: 'idle', NOT_QUEUED: 'idle', NOT_CHECKED: 'idle', NONE: 'idle', RESTORED: 'idle',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONE[STATUS_TONE[status] ?? 'idle']}`}>{label ?? status.replaceAll('_', ' ').toLowerCase()}</span>;
}

/** Where a video's title and description came from. */
export function SourceChip({ source, enhance }: { source: string | null; enhance?: string }) {
  if (enhance === 'PENDING' || enhance === 'RUNNING') return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE.violet}`}><Spinner className="h-3 w-3" />improving</span>;
  const map: Record<string, [string, string, string]> = {
    'manifest-ai': ['Improved by Gemini', 'violet', 'sparkles'],
    manifest: ['From JSON', 'info', 'file'],
    gemini: ['Gemini', 'violet', 'sparkles'],
    'user-edit': ['Written by you', 'good', 'user'],
  };
  const m = source ? map[source] : undefined;
  if (!m) return null;
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONE[m[1]]}`}><Icon name={m[2]} className="h-3 w-3" />{m[0]}</span>;
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-center gap-2 text-sm ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="h-4 w-4 rounded accent-indigo-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export const inputCls =
  'w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm shadow-sm placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-950';

/** Same look as inputCls but sized to its content, for dropdowns in a toolbar. */
export const selectCls =
  'rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 dark:border-zinc-700 dark:bg-zinc-950';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

type NoticeTone = 'info' | 'success' | 'warn' | 'error';
const NOTICE: Record<NoticeTone, [string, string]> = {
  info: ['border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200', 'info'],
  success: ['border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200', 'check'],
  warn: ['border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200', 'alert'],
  error: ['border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200', 'alert'],
};
export function Notice({ tone = 'info', children, action, className = '' }: { tone?: NoticeTone; children: ReactNode; action?: ReactNode; className?: string }) {
  const [cls, icon] = NOTICE[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`mb-4 flex flex-wrap items-start gap-3 rounded-xl border p-3 text-sm ${cls} ${className}`}>
      <Icon name={icon} className="mt-0.5 h-4 w-4" />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  return error ? <Notice tone="error">{error}</Notice> : null;
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <motion.div variants={rise} className="flex flex-col items-center rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><Icon name={icon} className="h-5 w-5" /></div>
      <div className="font-medium">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-zinc-500">{children}</div>}
    </motion.div>
  );
}

/** Polls an async loader; keeps the last good data on failure. */
export function usePoll<T>(load: () => Promise<T>, ms = 3000): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(load);
  ref.current = load;
  const reload = useCallback(() => {
    ref.current().then((d) => { setData(d); setError(null); }, (e) => setError(errorText(e)));
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { data, error, reload };
}

export const fmtDuration = (s: number | null) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
export const fmtSize = (b: number | null) => (b == null ? '' : b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${(b / 1e6).toFixed(1)} MB`);
export const fmtDate = (s: string | null) => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString() : '');
export const timeAgo = (s: string | null) => {
  if (!s) return '';
  const ms = Date.now() - new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};
