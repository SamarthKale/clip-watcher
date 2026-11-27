import { api, errorText } from '../api';
import { Button, Card, EmptyState, ErrorBanner, Icon, Notice, PageHeader, usePoll, fmtDate, timeAgo } from '../components/ui';
import { useState } from 'react';

interface Data {
  counts: Record<string, number>;
  blocked: { channelLimit: number; quota: number; resumeAfter: string | null; message: string | null };
  channel: { channel_id: string; channel_title: string } | null;
  paused: boolean;
  recent: { id: number; event_type: string; message: string; created_at: string }[];
}

const STEPS: { key: string; label: string; hint: string; icon: string; tone: string }[] = [
  { key: 'detected', label: 'Detected', hint: 'videos found in your folders', icon: 'folder', tone: 'text-zinc-600 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-300' },
  { key: 'metadataReady', label: 'Text ready', hint: 'title, description, hashtags', icon: 'file', tone: 'text-sky-700 bg-sky-100 dark:bg-sky-950 dark:text-sky-300' },
  { key: 'enhancing', label: 'Improving', hint: 'Gemini is polishing the text', icon: 'sparkles', tone: 'text-violet-700 bg-violet-100 dark:bg-violet-950 dark:text-violet-300' },
  { key: 'queued', label: 'Queued', hint: 'waiting to upload', icon: 'list', tone: 'text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300' },
  { key: 'uploading', label: 'Uploading', hint: 'sending to YouTube now', icon: 'upload', tone: 'text-indigo-700 bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-300' },
  { key: 'uploadComplete', label: 'On YouTube', hint: 'uploaded, being processed', icon: 'check', tone: 'text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300' },
  { key: 'published', label: 'Published', hint: 'live on your channel', icon: 'check', tone: 'text-emerald-700 bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300' },
];

const EVENT_ICON: Record<string, [string, string]> = {
  upload_complete: ['check', 'text-emerald-600'],
  upload_reconciled: ['check', 'text-emerald-600'],
  enhanced: ['sparkles', 'text-violet-600'],
  manifest_imported: ['file', 'text-sky-600'],
  blocked_channel_limit: ['alert', 'text-amber-600'],
  blocked_quota: ['alert', 'text-amber-600'],
  upload_failed: ['alert', 'text-red-600'],
  enhance_failed: ['alert', 'text-amber-600'],
  ai_failed: ['alert', 'text-red-600'],
  connected: ['user', 'text-sky-600'],
};

export function Dashboard() {
  const { data, error, reload } = usePoll(() => api.get<Data>('/api/dashboard'), 3000);
  const [err, setErr] = useState<string | null>(null);
  const empty = data && data.counts.detected === 0;
  const done = data ? data.counts.uploadComplete + data.counts.published : 0;
  const pct = data && data.counts.detected ? Math.round((done / data.counts.detected) * 100) : 0;

  const resume = async () => {
    setErr(null);
    try { await api.post('/api/queue/resume'); reload(); } catch (e) { setErr(errorText(e)); }
  };

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Everything Spikecut is doing, from finding a clip to it going live." />
      <ErrorBanner error={err ?? error} />

      {data?.paused && (
        <Notice tone="warn" action={<Button variant="primary" onClick={resume}><Icon name="play" />Resume uploads</Button>}>
          <b>Uploads are paused.</b> Nothing will be sent to YouTube until you resume. An upload in progress continues from where it stopped.
        </Notice>
      )}
      {data && data.blocked.channelLimit > 0 && (
        <Notice tone="warn" action={<a href="#/queue" className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900">Open queue</a>}>
          <b>YouTube's upload limit for your channel was reached.</b> {data.blocked.channelLimit} video{data.blocked.channelLimit === 1 ? ' is' : 's are'} waiting and nothing is lost. YouTube does not say when it resets; it usually clears about 24 hours after the earlier uploads. Verifying your channel by phone at youtube.com/verify raises the limit.
        </Notice>
      )}
      {data && data.blocked.quota > 0 && (
        <Notice tone="warn" action={<a href="#/queue" className="rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 dark:hover:bg-amber-900">Open queue</a>}>
          <b>YouTube's daily API quota was reached.</b> {data.blocked.quota} video{data.blocked.quota === 1 ? '' : 's'} will resume automatically{data.blocked.resumeAfter ? <> after about {fmtDate(data.blocked.resumeAfter)}</> : ''}, or when you press Retry.
        </Notice>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Connected YouTube channel</div>
            {data?.channel ? (
              <div className="text-lg font-semibold">{data.channel.channel_title}</div>
            ) : (
              <div className="text-sm">No channel confirmed yet. <a className="text-indigo-600 underline" href="#/accounts">Connect one in Accounts &amp; Channels.</a></div>
            )}
          </div>
          {data && data.counts.detected > 0 && (
            <div className="w-full sm:w-72">
              <div className="mb-1 flex justify-between text-xs text-zinc-500"><span>On YouTube</span><span>{done} of {data.counts.detected} ({pct}%)</span></div>
              <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
      </Card>

      {empty ? (
        <EmptyState icon="folder" title="No data yet">Add a folder in <a className="text-indigo-600 underline" href="#/folders">Folders</a>, then scan it. Videos will show up here as they move through the pipeline.</EmptyState>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Pipeline</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <Card key={s.key} className="relative">
                <div className="flex items-center justify-between">
                  <span className={`grid h-8 w-8 place-items-center rounded-lg ${s.tone}`}><Icon name={s.icon} /></span>
                  <span className="text-xs text-zinc-400">Step {i + 1}</span>
                </div>
                <div className="mt-3 text-3xl font-semibold tabular-nums" data-testid={`count-${s.key}`}>{data ? data.counts[s.key] : '-'}</div>
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs text-zinc-500">{s.hint}</div>
              </Card>
            ))}
            <Card className={data && data.counts.failed > 0 ? 'border-red-300 dark:border-red-900' : ''}>
              <div className="flex items-center justify-between">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${data && data.counts.failed > 0 ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800'}`}><Icon name="alert" /></span>
                <span className="text-xs text-zinc-400">Attention</span>
              </div>
              <div className="mt-3 text-3xl font-semibold tabular-nums" data-testid="count-failed">{data ? data.counts.failed : '-'}</div>
              <div className="text-sm font-medium">Needs attention</div>
              <div className="text-xs text-zinc-500">failed or unclear outcome</div>
            </Card>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-zinc-500">
            <span>Waiting for your approval: <b className="text-zinc-800 dark:text-zinc-200" data-testid="count-awaitingApproval">{data?.counts.awaitingApproval ?? '-'}</b></span>
            <span>Skipped or duplicate: <b className="text-zinc-800 dark:text-zinc-200" data-testid="count-skipped">{data?.counts.skipped ?? '-'}</b></span>
          </div>
        </>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-zinc-500">Recent activity</h2>
      <Card className="p-0">
        {data && data.recent.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">No activity yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {data?.recent.map((r) => {
              const [icon, tone] = EVENT_ICON[r.event_type] ?? ['info', 'text-zinc-500'];
              return (
                <li key={r.id} className="flex items-start gap-3 px-4 py-2.5">
                  <Icon name={icon} className={`mt-0.5 h-4 w-4 ${tone}`} />
                  <span className="min-w-0 flex-1">{r.message}</span>
                  <span className="shrink-0 text-xs text-zinc-500" title={fmtDate(r.created_at)}>{timeAgo(r.created_at)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
