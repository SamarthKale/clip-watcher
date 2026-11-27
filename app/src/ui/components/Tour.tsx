import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BRAND, LogoMark } from '../brand';
import { Button, Icon } from './ui';

/**
 * The guided tour. It opens by itself the first time the app runs (until it is finished or skipped,
 * remembered in the app's settings) and any time from "Take the tour". Each step opens the page it
 * describes and points at it in the sidebar, so the explanation sits next to the real screen.
 */
/** Any page can open the tour by sending this event (App listens for it). */
export const OPEN_TOUR_EVENT = 'spikecut:tour';
export const openTour = () => window.dispatchEvent(new Event(OPEN_TOUR_EVENT));

export interface TourStep {
  id: string;
  /** Page to open while this step is shown (sidebar id). */
  page?: string;
  icon: string;
  kicker: string;
  title: string;
  body: ReactNode;
}

const Li = ({ children }: { children: ReactNode }) => (
  <li className="flex gap-2"><span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" /><span>{children}</span></li>
);
const List = ({ children }: { children: ReactNode }) => <ul className="mt-3 space-y-1.5">{children}</ul>;

const FLOW: [string, string, string][] = [
  ['Record', 'terminal', 'Records the live stream to your disk, from the first second.'],
  ['Detect', 'chart', 'Reads chat and flags the moments it suddenly explodes.'],
  ['Cut', 'scissors', 'Cuts 75 seconds either side of each spike and transcribes it.'],
  ['Edit', 'sparkles', 'Claude edits a vertical Short with captions, sound and a title.'],
  ['Publish', 'youtube', 'You approve it and it uploads to your YouTube channel.'],
];

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    icon: 'compass',
    kicker: 'Welcome',
    title: `Welcome to ${BRAND.name}`,
    body: (
      <>
        <p>{BRAND.name} watches a live stream for you, catches the moments when chat goes wild, and turns each one into a finished vertical Short, ready for YouTube, TikTok and Reels.</p>
        <p className="mt-3">This tour walks through every part of the app in about three minutes. Each step opens the page it describes, so you can see it as you read. You can leave at any time and reopen the tour from <b>Take the tour</b> at the bottom of the sidebar.</p>
      </>
    ),
  },
  {
    id: 'flow',
    icon: 'chart',
    kicker: 'How it works',
    title: 'Five stages, fully automatic',
    body: (
      <>
        <p>Once you start watching a channel, every stage runs by itself in the background. Nothing is ever posted without the publishing rule you choose.</p>
        <ol className="mt-4 space-y-2">
          {FLOW.map(([name, icon, text], i) => (
            <li key={name} className="flex items-start gap-3">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><Icon name={icon} className="h-4 w-4" /></span>
              <span><b>{i + 1}. {name}.</b> {text}</span>
            </li>
          ))}
        </ol>
      </>
    ),
  },
  {
    id: 'home',
    page: 'home',
    icon: 'grid',
    kicker: 'Home',
    title: 'Start watching a channel',
    body: (
      <>
        <p>Home is your control room. Paste a Twitch channel link (or just the name) and press <b>Start watching</b>.</p>
        <List>
          <Li>If the streamer is offline, {BRAND.name} waits and starts recording the moment they go live.</Li>
          <Li>The status chips show whether the pipeline is running and whether the stream is being recorded.</Li>
          <Li><b>Chat, live</b> plots messages every 10 seconds. When a bar crosses the dashed line, that moment becomes a spike.</Li>
          <Li><b>Stop</b> closes the recording cleanly. If you close the window while recording, you are asked whether to stop or keep recording in the background.</Li>
          <Li>If a required tool is missing, a <b>Setup needed</b> panel here names it and where to get it.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'spikes',
    page: 'spikes',
    icon: 'sparkles',
    kicker: 'Spikes & clips',
    title: 'Every moment chat exploded',
    body: (
      <>
        <p>Each spike is listed with its score and where its clip is right now: cutting, transcribing, editing or done.</p>
        <List>
          <Li>The highest-scoring moments are edited first, so the best Shorts arrive soonest.</Li>
          <Li><b>Skip</b> drops a clip you don't want. <b>Retry</b> runs a failed step again, for example after a stream ad break.</Li>
          <Li>Raw footage is kept until its Short is made, checked and backed up.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'shorts',
    page: 'shorts',
    icon: 'film',
    kicker: 'Shorts',
    title: 'Your finished Shorts',
    body: (
      <>
        <p>Every Short that finishes editing appears here, newest first, ready to play.</p>
        <List>
          <Li>Shorts run about 50 to 60 seconds, reframed to 9:16 with the facecam and gameplay arranged for a phone.</Li>
          <Li>Captions are always in Latin letters. English stays English; Hindi and Hinglish speech is written the way people type it.</Li>
          <Li>Each Short keeps its attribution: the streamer, their channel link and the original timestamps.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'review',
    page: 'library',
    icon: 'check',
    kicker: 'Review & publish',
    title: 'Approve before anything goes live',
    body: (
      <>
        <p>With the default <b>Review first</b> mode, every Short waits here for you.</p>
        <List>
          <Li>Open a Short to watch it and read the title, description and hashtags Claude wrote for it.</Li>
          <Li>Change any text you like; your edits are saved and marked as written by you.</Li>
          <Li>Press <b>Approve for upload</b> to send it to the upload queue, or select Shorts and use <b>Reject / skip</b> to keep them off YouTube.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'vod',
    page: 'vod',
    icon: 'link',
    kicker: 'Add a video',
    title: 'Any video, made into Shorts',
    body: (
      <>
        <p>Paste any video link: a stream that already ended, a <b>podcast</b>, any <b>YouTube</b> video, or most other video sites. Spikecut starts on it by itself: download, find the best moments, edit.</p>
        <List>
          <Li>Streams with a chat replay are clipped where chat spiked. Everything else is transcribed in full and Claude picks the moments; you choose how many Shorts per video.</Li>
          <Li>The <b>watch list</b> follows streamers for you: new broadcasts are picked up automatically, optionally only when the title contains a keyword you set.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'accounts',
    page: 'accounts',
    icon: 'youtube',
    kicker: 'YouTube account',
    title: 'Connect your channel once',
    body: (
      <>
        <p>To upload, connect the Google account that owns your channel.</p>
        <List>
          <Li>Paste the OAuth client ID from your Google Cloud project (YouTube Data API v3 enabled), then press <b>Connect Google account</b> and sign in in your browser.</Li>
          <Li>Press <b>Confirm this channel</b>. Nothing is ever uploaded until a channel is confirmed.</Li>
          <Li>Your sign-in is stored encrypted on this PC with Windows protection. {BRAND.name} never sees or stores your Google password.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'queue',
    page: 'queue',
    icon: 'upload',
    kicker: 'Upload queue',
    title: 'Safe, resumable uploads',
    body: (
      <>
        <p>Approved Shorts upload to YouTube one at a time.</p>
        <List>
          <Li>Uploads resume where they stopped after a network drop or a restart.</Li>
          <Li>If YouTube reports its daily limit, uploads pause and the reason is shown. Nothing is lost and nothing tries to get around the limit.</Li>
          <Li>If an upload's result is uncertain, it is never sent twice; you decide what happens.</Li>
          <Li><b>Pause uploads</b> and <b>Resume uploads</b> are always one click away.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'history',
    page: 'history',
    icon: 'clock',
    kicker: 'Upload history',
    title: 'A record of everything published',
    body: (
      <>
        <p>Every upload is listed with its YouTube link, video ID, visibility and processing status.</p>
        <List>
          <Li>Search and filter the history at any time.</Li>
          <Li><b>Export CSV</b> downloads the full record for your own spreadsheets.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'usage',
    page: 'usage',
    icon: 'wallet',
    kicker: 'Claude usage',
    title: 'Know what each Short costs',
    body: (
      <>
        <p>Every edit is done by Claude, and every attempt is recorded, including ones that failed.</p>
        <List>
          <Li>See tokens, turns, time and the estimated cost at list price for each video, each stream and each day.</Li>
          <Li>A per-clip spending cap stops retries on a clip that keeps failing, so one bad clip can't run up the bill.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'storage',
    page: 'storage',
    icon: 'database',
    kicker: 'Storage',
    title: 'Free up space without losing work',
    body: (
      <>
        <p>Recordings are large. Storage shows what takes space and lets you clean up safely.</p>
        <List>
          <Li>Every cleanup starts with a preview; nothing is deleted until you confirm it.</Li>
          <Li>A recording can only go once its clips are cut, backed up, and its Shorts are uploaded or discarded.</Li>
          <Li>Each item is checked again at the moment it is deleted.</Li>
        </List>
      </>
    ),
  },
  {
    id: 'log',
    page: 'log',
    icon: 'terminal',
    kicker: 'Live log',
    title: 'See exactly what is happening',
    body: (
      <>
        <p>The live log shows everything each stage reports, as it happens: the recorder, chat, detector, cutter, transcriber, editor and storage.</p>
        <p className="mt-3">Spikes are highlighted in green and problems in amber or red. If something looks stuck, this is the first place to look.</p>
      </>
    ),
  },
  {
    id: 'settings',
    page: 'settings',
    icon: 'settings',
    kicker: 'Settings',
    title: 'Choose how Shorts are published',
    body: (
      <>
        <p>Under <b>Publishing</b>, choose what happens to each new Short:</p>
        <List>
          <Li><b>Review first</b> (default): every Short waits for your approval.</Li>
          <Li><b>Auto-publish</b>: new Shorts upload by themselves with the visibility you pick: private, unlisted or public.</Li>
        </List>
        <p className="mt-3">Changing the mode only affects Shorts that aren't queued yet. YouTube's own daily limits always apply.</p>
      </>
    ),
  },
  {
    id: 'ready',
    icon: 'check',
    kicker: "You're ready",
    title: 'Four steps to your first Short',
    body: (
      <>
        <ol className="mt-1 space-y-2.5">
          {[
            ['Set up Claude on Home', 'once, and sign in with your own Claude account.'],
            ['Connect your YouTube account', 'and confirm the channel.'],
            ['Pick a publishing mode', 'in Settings (Review first is a safe start).'],
            ['Paste a Twitch channel on Home', 'and press Start watching.'],
          ].map(([a, b], i) => (
            <li key={a} className="flex items-start gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-indigo-600 text-xs font-semibold text-white">{i + 1}</span>
              <span><b>{a}</b> {b}</span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-zinc-500">You can reopen this tour any time from <b>Take the tour</b> in the sidebar or in Settings.</p>
      </>
    ),
  },
];

export function Tour({ open, onClose, onStep }: { open: boolean; onClose: (finished?: boolean) => void; onStep: (step: TourStep) => void }) {
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const step = TOUR_STEPS[i];
  const last = i === TOUR_STEPS.length - 1;
  const centered = !step.page;

  useEffect(() => { if (open) { setI(0); setDir(1); } }, [open]);
  useEffect(() => { if (open) onStep(step); }, [open, step, onStep]);

  const go = (n: number) => { setDir(n > i ? 1 : -1); setI(Math.max(0, Math.min(TOUR_STEPS.length - 1, n))); };
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') { if (last) onClose(true); else go(i + 1); }
      else if (e.key === 'ArrowLeft') go(i - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="tour"
          data-tour-layer
          className={`fixed inset-0 z-50 flex p-4 sm:p-6 ${centered ? 'items-center justify-center' : 'items-end justify-end'} pointer-events-none`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="pointer-events-auto absolute inset-0 bg-zinc-900/20 backdrop-blur-[6px]"
            initial={false}
            animate={{ opacity: centered ? 1 : 0 }}
            style={{ pointerEvents: centered ? 'auto' : 'none' }}
            onClick={() => onClose()}
          />
          <motion.div
            layout
            role="dialog"
            aria-modal={centered}
            aria-label={`${BRAND.name} tour`}
            className="tour-card pointer-events-auto relative w-full max-w-[30rem] overflow-hidden rounded-2xl border border-zinc-200 shadow-xl shadow-black/[0.06] dark:border-zinc-800"
            initial={{ opacity: 0, y: 24, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <div className="h-1 bg-zinc-100 dark:bg-zinc-800">
              <motion.div className="h-full bg-indigo-400" animate={{ width: `${((i + 1) / TOUR_STEPS.length) * 100}%` }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} />
            </div>
            <div className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-indigo-600 dark:text-indigo-300">{step.kicker}</span>
                <span className="tabular text-xs text-zinc-500">{i + 1} of {TOUR_STEPS.length}</span>
              </div>
              <AnimatePresence mode="wait" custom={dir} initial={false}>
                <motion.div
                  key={step.id}
                  custom={dir}
                  initial={{ opacity: 0, x: 18 * dir }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -18 * dir }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                >
                  <div className="mb-3 flex items-center gap-3">
                    {step.id === 'welcome'
                      ? <LogoMark size={44} draw />
                      : <span className="grid h-11 w-11 place-items-center rounded-2xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300"><Icon name={step.icon} className="h-5 w-5" /></span>}
                    <h2 className="text-xl font-semibold leading-snug tracking-[-0.01em]">{step.title}</h2>
                  </div>
                  <div className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{step.body}</div>
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-zinc-200 px-6 py-3.5 dark:border-zinc-800">
              <Button variant="ghost" onClick={() => onClose()}>{last ? 'Close' : 'Skip tour'}</Button>
              <div className="flex items-center gap-2">
                {i > 0 && <Button onClick={() => go(i - 1)}><Icon name="arrowLeft" className="h-3.5 w-3.5" />Back</Button>}
                {last
                  ? <Button variant="primary" onClick={() => onClose(true)}>Get started<Icon name="arrowRight" className="h-3.5 w-3.5" /></Button>
                  : <Button variant="primary" onClick={() => go(i + 1)}>{i === 0 ? 'Start the tour' : 'Next'}<Icon name="arrowRight" className="h-3.5 w-3.5" /></Button>}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
