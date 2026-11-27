import { useState } from 'react';
import { api, errorText } from '../api';
import { Button, Card, ErrorBanner, Field, PageHeader, StatusBadge, inputCls, usePoll } from '../components/ui';
import type { Account } from '../types';

interface Data {
  clientIdSet: boolean;
  pending: { state: 'waiting' | 'error'; message?: string } | null;
  accounts: Account[];
}

export function Accounts() {
  const d = usePoll(() => api.get<Data>('/api/accounts'), 2000);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); d.reload(); } catch (e) { setError(errorText(e)); }
  };

  return (
    <div>
      <PageHeader title="Accounts & Channels" />
      <ErrorBanner error={error ?? d.error} />
      <Card className="mb-4 space-y-3">
        <h2 className="font-semibold">Google OAuth client</h2>
        <p className="text-sm text-zinc-500">Create a "Desktop app" OAuth client in the Google Cloud Console for a project with the YouTube Data API v3 enabled, then paste its client ID here. Spikecut uses the browser sign-in flow with PKCE and requests only the YouTube upload and read-only scopes.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={d.data?.clientIdSet ? 'Client ID (saved; enter a new one to replace)' : 'Client ID'}><input className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" /></Field>
          <Field label="Client secret (only if Google issued one)"><input className={inputCls} type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></Field>
        </div>
        <Button disabled={clientId.trim().length < 5} onClick={() => run(async () => { await api.put('/api/accounts/oauth-client', { clientId: clientId.trim(), ...(clientSecret ? { clientSecret } : {}) }); setClientId(''); setClientSecret(''); })}>Save client</Button>
      </Card>

      <Card className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">YouTube channels</h2>
          <Button variant="primary" disabled={!d.data?.clientIdSet || d.data.pending?.state === 'waiting'} onClick={() => run(async () => { const r = await api.post<{ authUrl: string }>('/api/accounts/connect'); window.open(r.authUrl, '_blank', 'noopener'); })}>Connect Google account</Button>
        </div>
        {d.data?.pending?.state === 'waiting' && <p className="text-sm text-sky-700 dark:text-sky-300">Waiting for you to finish signing in in the browser tab that opened...</p>}
        {d.data?.pending?.state === 'error' && <p className="text-sm text-red-600">Connection failed: {d.data.pending.message}</p>}
        {d.data && d.data.accounts.length === 0 && <p className="text-sm text-zinc-500">No channel connected yet.</p>}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {d.data?.accounts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <div className="font-medium" data-testid="channel-title">{a.channel_title}</div>
                <div className="text-xs text-zinc-500">{a.channel_id}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {a.needs_reauth ? <StatusBadge status="REJECTED" label="reconnect needed" /> : a.confirmed ? <StatusBadge status="VALID" label="uploads go to this channel" /> : <StatusBadge status="PENDING" label="not confirmed" />}
                {!a.confirmed && !a.needs_reauth && <Button variant="primary" onClick={() => run(async () => { await api.post(`/api/accounts/${a.id}/confirm`); })}>Confirm this channel</Button>}
                <Button variant="danger" onClick={() => { if (confirm(`Disconnect ${a.channel_title}? Queued uploads will pause.`)) void run(async () => { const r = await api.del<{ guidance: string }>(`/api/accounts/${a.id}`); setGuidance(r.guidance); }); }}>Disconnect</Button>
              </div>
            </li>
          ))}
        </ul>
        {guidance && <p className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{guidance}</p>}
      </Card>
      <p className="text-xs text-zinc-500">Before bulk publishing, confirm the channel name above is the one you intend. Spikecut never uploads until a channel is confirmed.</p>
    </div>
  );
}
