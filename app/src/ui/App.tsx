import { useEffect, useState, type ComponentType } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Folders } from './pages/Folders';
import { Profiles } from './pages/Profiles';
import { Library } from './pages/Library';
import { Queue } from './pages/Queue';
import { History } from './pages/History';
import { Accounts } from './pages/Accounts';
import { SettingsPage } from './pages/Settings';
import { api } from './api';
import { Icon, usePoll } from './components/ui';

const PAGES: { id: string; label: string; icon: string; Page: ComponentType }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid', Page: Dashboard },
  { id: 'folders', label: 'Folders', icon: 'folder', Page: Folders },
  { id: 'profiles', label: 'AI Profiles', icon: 'sparkles', Page: Profiles },
  { id: 'library', label: 'Video Library', icon: 'film', Page: Library },
  { id: 'queue', label: 'Processing Queue', icon: 'list', Page: Queue },
  { id: 'history', label: 'Upload History', icon: 'clock', Page: History },
  { id: 'accounts', label: 'Accounts & Channels', icon: 'user', Page: Accounts },
  { id: 'settings', label: 'Settings', icon: 'settings', Page: SettingsPage },
];

const routeFromHash = () => {
  const r = location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === r) ? r : 'dashboard';
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
  const dot = data.paused ? 'bg-amber-500' : busy ? 'bg-sky-500 animate-pulse' : 'bg-emerald-500';
  const label = data.paused ? 'Uploads paused' : busy ? 'Uploading now' : 'Idle';
  return (
    <div className="mt-auto space-y-2 rounded-xl border border-zinc-200 bg-white p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2 font-medium"><span className={`h-2 w-2 rounded-full ${dot}`} />{label}</div>
      <div className="text-zinc-500">{data.channel ? <>Channel: <span className="font-medium text-zinc-700 dark:text-zinc-200">{data.channel.channel_title}</span></> : 'No channel confirmed'}</div>
      {data.counts.enhancing > 0 && <div className="flex items-center gap-1 text-violet-600 dark:text-violet-300"><Icon name="sparkles" className="h-3 w-3" />Improving {data.counts.enhancing} with Gemini</div>}
    </div>
  );
}

export function App() {
  // Signing in once lets this browser stay signed in across refreshes, new tabs and restarts.
  const [route, setRoute] = useState(() => {
    void api.post('/api/session/login').catch(() => undefined);
    return routeFromHash();
  });
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const on = () => {
      setRoute(routeFromHash());
      setMenu(false);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const current = PAGES.find((p) => p.id === route)!;
  const Current = current.Page;
  return (
    <div className="min-h-screen lg:flex">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-white"><Icon name="upload" /></span>LocalTube</div>
        <button aria-label="Menu" className="rounded-lg p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setMenu(!menu)}><Icon name={menu ? 'x' : 'menu'} className="h-5 w-5" /></button>
      </header>
      <nav
        aria-label="Main"
        className={`${menu ? 'flex' : 'hidden'} fixed inset-x-0 top-[53px] bottom-0 z-20 flex-col gap-1 overflow-y-auto bg-zinc-50 p-4 lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-60 lg:shrink-0 lg:border-r lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800`}
      >
        <div className="mb-5 hidden items-center gap-2 px-2 text-lg font-bold lg:flex"><span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-white"><Icon name="upload" className="h-4 w-4" /></span>LocalTube</div>
        <ul className="space-y-0.5">
          {PAGES.map((p) => (
            <li key={p.id}>
              <a
                href={`#/${p.id}`}
                aria-current={route === p.id ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${route === p.id ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}
              >
                <Icon name={p.icon} />
                {p.label}
              </a>
            </li>
          ))}
        </ul>
        <StatusFooter />
      </nav>
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-6xl">
          <Current />
        </div>
      </main>
    </div>
  );
}
