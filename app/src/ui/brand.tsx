import { useId } from 'react';
import { motion } from 'motion/react';

/** The product name, in one place. Internal names (the Python package, data folders) are unchanged. */
export const BRAND = {
  name: 'Spikecut',
  tagline: 'Catch the spike. Cut the Short.',
} as const;

/** The chat line that shoots up into a spike; a clean slash cuts through its peak. */
export const SPIKE_PATH = 'M12 38 H21 L25 33 L29 38 H33 L40 15 L47 38 H52';
export const CUT_LINE = { x1: 31, y1: 31.5, x2: 50, y2: 19.5 };

/**
 * The Spikecut mark (flat and matte, tinted by the current theme). `draw` animates the line drawing itself (splash, tour), otherwise it is static.
 * Motion respects the Windows "reduce animations" setting through MotionConfig in App.
 */
export function LogoMark({ size = 32, draw = false, className = '' }: { size?: number; draw?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={`shrink-0 ${className}`} aria-hidden="true">
      <defs>
        <mask id={`m${id}`}>
          <rect width="64" height="64" fill="#fff" />
          <line {...CUT_LINE} stroke="#000" strokeWidth="3.4" strokeLinecap="round" />
        </mask>
      </defs>
      {/* flat, matte tile in the current theme's accent */}
      <rect width="64" height="64" rx="16" style={{ fill: 'var(--color-indigo-500)' }} />
      <g mask={`url(#m${id})`}>
        <motion.path
          d={SPIKE_PATH}
          fill="none"
          stroke="#fff"
          strokeWidth="4.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={draw ? { pathLength: 0 } : false}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: [0.65, 0, 0.35, 1] }}
        />
      </g>
      <motion.circle
        cx="50.5"
        cy="14"
        r="3.4"
        style={{ fill: 'var(--color-coral-400)' }}
        initial={draw ? { scale: 0, opacity: 0 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: draw ? 0.85 : 0, type: 'spring', stiffness: 420, damping: 16 }}
      />
    </svg>
  );
}

/** Mark plus the word "Spikecut" ("cut" in the brand violet). */
export function Wordmark({ size = 30, className = '' }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark size={size} />
      <span className="brand-word text-[1.15rem] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50">
        Spike<span className="text-indigo-600 dark:text-indigo-400">cut</span>
      </span>
    </span>
  );
}

/* ---------- colour themes (all pastel and matte; the scales live in index.css) ---------- */
export const THEMES: { id: 'lavender' | 'sage' | 'clay' | 'mist'; name: string; note: string; swatch: [string, string, string] }[] = [
  { id: 'lavender', name: 'Lavender', note: 'Soft violet-grey. The default.', swatch: ['#eeeaf7', '#a99cd2', '#7a6dad'] },
  { id: 'sage', name: 'Sage', note: 'Muted green, calm and natural.', swatch: ['#e6efe8', '#8fb199', '#5f8269'] },
  { id: 'clay', name: 'Clay', note: 'Warm terracotta and sand.', swatch: ['#f6e9e2', '#cd957c', '#a2664e'] },
  { id: 'mist', name: 'Mist', note: 'Cool dusty blue.', swatch: ['#e6edf5', '#8ea8c8', '#5f789b'] },
];
export type ThemeName = (typeof THEMES)[number]['id'];

/** Applies a theme to the whole page at once (the CSS swaps the accent scale). */
export function applyTheme(id: string | undefined): void {
  const t = THEMES.some((x) => x.id === id) ? id! : 'lavender';
  if (t === 'lavender') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
