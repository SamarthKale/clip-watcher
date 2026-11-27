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
 * The Spikecut mark. `draw` animates the line drawing itself (splash, tour), otherwise it is static.
 * Motion respects the Windows "reduce animations" setting through MotionConfig in App.
 */
export function LogoMark({ size = 32, draw = false, className = '' }: { size?: number; draw?: boolean; className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={`shrink-0 ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8f72ff" />
          <stop offset="1" stopColor="#5326e0" />
        </linearGradient>
        <mask id={`m${id}`}>
          <rect width="64" height="64" fill="#fff" />
          <line {...CUT_LINE} stroke="#000" strokeWidth="3.4" strokeLinecap="round" />
        </mask>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#g${id})`} />
      <rect x="1" y="1" width="62" height="62" rx="15" fill="none" stroke="#fff" strokeOpacity="0.22" strokeWidth="1.5" />
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
        fill="#ff5a5f"
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
