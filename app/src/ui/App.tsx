import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react';
import { Dashboard } from './pages/Dashboard';
import { Folders } from './pages/Folders';
import { Profiles } from './pages/Profiles';
import { Library } from './pages/Library';
import { Queue } from './pages/Queue';
import { History } from './pages/History';
import { Accounts } from './pages/Accounts';
import { Home } from './pages/Home';
import { Spikes } from './pages/Spikes';
import { Shorts } from './pages/Shorts';
import { Vod } from './pages/Vod';
import { Usage } from './pages/Usage';
import { Storage } from './pages/Storage';
import { LogPage } from './pages/LogPage';
import { SettingsPage } from './pages/Settings';
import { api } from './api';
import { BRAND, Wordmark, applyTheme } from './brand';
import { Icon, LiveDot, usePoll } from './components/ui';
import { OPEN_TOUR_EVENT, Tour, type TourStep } from './components/Tour';

type Group = 'Create' | 'Publish' | 'System';
const PAGES: { id: string; label: string; icon: string; Page: ComponentType; group?: Group }[] = [
  { id: 'home', label: 'Home', icon: 'grid', Page: Home, group: 'Create' },
  { id: 'spikes', label: 'Spikes & clips', icon: 'sparkles', Page: Spikes, group: 'Create' },
  { id: 'shorts', label: 'Shorts', icon: 'film', Page: Shorts, group: 'Create' },
  { id: 'vod', label: 'Add a VOD', icon: 'link', Page: Vod, group: 'Create' },
  { id: 'library', label: 'Review & publish', icon: 'check', Page: Library, group: 'Publish' },
  { id: 'queue', label: 'Upload queue', icon: 'upload', Page: Queue, group: 'Publish' },
  { id: 'history', label: 'Upload history', icon: 'clock', Page: History, group: 'Publish' },
  { id: 'accounts', label: 'YouTube account', icon: 'youtube', Page: Accounts, group: 'Publish' },
  { id: 'usage', label: 'Claude usage', icon: 'wallet', Page: Usage, group: 'System' },
  { id: 'storage', label: 'Storage', icon: 'database', Page: Storage, group: 'System' },
  { id: 'log', label: 'Live log', icon: 'terminal', Page: LogPage, group: 'System' },
  { id: 'settings', label: 'Settings', icon: 'settings', Page: SettingsPage, group: 'System' },
  // Still reachable by address, but not in the sidebar: folders are automatic and titles come from Claude.
  { id: 'dashboard', label: 'Upload dashboard', icon: 'grid', Page: Dashboard },
  { id: 'folders', label: 'Folders', icon: 'folder', Page: Folders },
  { id: 'profiles', label: 'AI Profiles', icon: 'sparkles', Page: Profiles },
];
const GROUPS: Group[] = ['Create', 'Publish', 'System'];

const routeFromHash = () => {
  const r = location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === r) ? r : 'home';
};

interface Shell {
  counts: Record<string, number>;
  channel: { channel_title: string } | null;
  paused: boolean;
}

function StatusFooter() {
  const { data } = usePoll(() => api.get<Shell>('/api/dashboard'), 4000);
  if (!data) return null;
  const busy = data.counts.uploading > 0;
  const label = data.paused ? 'Uploads paused' : busy ? 'Uploading now' : 'Uploads idle';
  return (
    <div className="space-y-1.5 rounded-xl border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 font-medium">
        {busy ? <LiveDot className="text-indigo-500" /> : <span className={`h-2 w-2 rounded-full ${data.paused ? 'bg-amber-500' : 'bg-emerald-500'}`} />}
        {label}
      </div>
      <div className="truncate text-zinc-500">{data.channel ? <>Channel: <span className="font-medium text-zinc-700 dark:text-zinc-200">{data.channel.channel_title}</span></> : 'No YouTube channel connected'}</div>
      {data.counts.enhancing > 0 && <div className="flex items-center gap-1 text-indigo-600 dark:text-indigo-300"><Icon name="sparkles" className="h-3 w-3" />Improving {data.counts.enhancing} with Gemini</div>}
    </div>
  );
}

function NavItem({ p, active, highlighted }: { p: (typeof PAGES)[number]; active: boolean; highlighted: boolean }) {
  return (
    <li>
      <a
        href={`#/${p.id}`}
        aria-current={active ? 'page' : undefined}
        className={`relative flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm font-medium transition-colors ${active ? 'text-indigo-700 dark:text-white' : 'text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'} ${highlighted ? 'tour-target' : ''}`}
      >
        {active && (
          <motion.span
            layoutId="nav-active"
            className="absolute inset-0 rounded-lg bg-white shadow-[0_1px_2px_rgb(40_36_30/0.06)] ring-1 ring-black/[0.05] dark:bg-indigo-600 dark:ring-0"
            transition={{ type: 'spring', stiffness: 520, damping: 40 }}
          />
        )}
        <Icon name={p.icon} className={`relative h-4 w-4 ${active ? 'text-indigo-600 dark:text-white' : ''}`} />
        <span className="relative">{p.label}</span>
      </a>
    </li>
  );
}

/** Page content rises in, staggered; the old page fades out first. */
const pageVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.045, delayChildren: 0.02 } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12 } },
};

export function App() {
  // Signing in once lets this browser stay signed in across refreshes, new tabs and restarts.
  const [route, setRoute] = useState(() => {
    void api.post('/api/session/login').catch(() => undefined);
    return routeFromHash();
  });
  const [menu, setMenu] = useState(false);
  const [tour, setTour] = useState(false);
  const [tourPage, setTourPage] = useState<string | null>(null);

  useEffect(() => {
    const on = () => {
      setRoute(routeFromHash());
      setMenu(false);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // First run: the tour opens by itself until it has been finished or skipped once.
  useEffect(() => {
    let live = true;
    api.get<{ tourSeen?: boolean; theme?: string }>('/api/settings').then((s) => {
      if (!live) return;
      applyTheme(s.theme);
      if (s.tourSeen === false) setTour(true);
    }, () => undefined);
    const open = () => setTour(true);
    window.addEventListener(OPEN_TOUR_EVENT, open);
    return () => { live = false; window.removeEventListener(OPEN_TOUR_EVENT, open); };
  }, []);

  const onStep = useCallback((s: TourStep) => {
    setTourPage(s.page ?? null);
    if (s.page && routeFromHash() !== s.page) location.hash = `#/${s.page}`;
  }, []);
  const closeTour = (finished?: boolean) => {
    setTour(false);
    setTourPage(null);
    if (finished) location.hash = '#/home'; // "Get started" lands on Home, where the first step is
    void api.put('/api/settings', { tourSeen: true }).catch(() => undefined);
  };

  const current = PAGES.find((p) => p.id === route)!;
  const Current = current.Page;
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen lg:flex">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/90">
          <Wordmark size={26} />
          <button aria-label="Menu" className="rounded-lg p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setMenu(!menu)}><Icon name={menu ? 'x' : 'menu'} className="h-5 w-5" /></button>
        </header>
        <nav
          aria-label="Main"
          className={`${menu ? 'flex' : 'hidden'} fixed inset-x-0 top-[53px] bottom-0 z-20 flex-col overflow-y-auto bg-zinc-50 px-3 pb-3 pt-4 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-64 lg:shrink-0 lg:border-r lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800`}
        >
          <a href="#/home" className="mb-5 hidden px-2 lg:block" aria-label={`${BRAND.name} home`}><Wordmark size={32} /></a>
          <LayoutGroup id="nav">
            {GROUPS.map((g) => (
              <div key={g} className="mb-3">
                <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">{g}</div>
                <ul className="space-y-0.5">
                  {PAGES.filter((p) => p.group === g).map((p) => <NavItem key={p.id} p={p} active={route === p.id} highlighted={tour && tourPage === p.id} />)}
                </ul>
              </div>
            ))}
          </LayoutGroup>
          <div className="mt-auto space-y-2 pt-2">
            <button
              onClick={() => setTour(true)}
              className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-indigo-50 hover:text-indigo-700 dark:text-zinc-300 dark:hover:bg-indigo-950 dark:hover:text-indigo-200"
            >
              <Icon name="compass" className="h-4 w-4 transition-transform duration-300 group-hover:rotate-45" />
              Take the tour
            </button>
            <StatusFooter />
          </div>
        </nav>
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-6xl">
            <AnimatePresence mode="wait">
              <motion.div key={route} variants={pageVariants} initial="hidden" animate="show" exit="exit">
                <Current />
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
      <Tour open={tour} onClose={closeTour} onStep={onStep} />
    </MotionConfig>
  );
}
