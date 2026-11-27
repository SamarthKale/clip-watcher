import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Button, Card, ErrorBanner, Field, Icon, Notice, PageHeader, Spinner, Toggle, inputCls, selectCls, usePoll } from '../components/ui';
import type { Settings } from '../types';
import { openTour } from '../components/Tour';

export function SettingsPage() {
  const s = usePoll(() => api.get<Settings>('/api/settings'), 60000);
  const [form, setForm] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [test, setTest] = useState<{ ok: boolean; model?: string; ms?: number; error?: string; hint?: string } | 'running' | null>(null);

  useEffect(() => { if (s.data && !form) setForm(s.data); }, [s.data, form]);
  if (!form) return <div><PageHeader title="Settings" /><ErrorBanner error={s.error} /></div>;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null); setNote('');
    try { await fn(); setNote(ok); s.reload(); } catch (e) { setError(errorText(e)); }
  };
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  const saveSettings = () => run(async () => {
    const { geminiKeySet: _k, googleClientId: _g, queuePaused: _q, tourSeen: _t, ...rest } = form;
    const next = await api.put<Settings>('/api/settings', rest);
    setForm(next);
  }, 'Settings saved');

  return (
    <div>
      <PageHeader title="Settings">
        <Button onClick={openTour}><Icon name="compass" />Take the tour</Button>
      </PageHeader>
      <ErrorBanner error={error ?? s.error} />
      {note && <div className="mb-3 text-sm text-emerald-600" role="status">{note}</div>}

      <Card className="mb-4 space-y-3">
        <h2 className="font-semibold">Publishing</h2>
        <p className="text-sm text-zinc-500">Finished Shorts appear in the Spikecut library automatically. Choose what happens to them next.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={`cursor-pointer rounded-xl border p-3 ${form.publishMode === 'review' ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-300/60 dark:border-zinc-700'}`}>
            <input type="radio" name="mode" className="mr-2" checked={form.publishMode === 'review'} onChange={() => setForm({ ...form, publishMode: 'review' })} />
            <b>Review first</b>
            <p className="mt-1 text-sm text-zinc-500">Every Short waits in Review &amp; publish. You watch it, edit the text, and approve it before anything goes to YouTube.</p>
          </label>
          <label className={`cursor-pointer rounded-xl border p-3 ${form.publishMode === 'auto' ? 'border-indigo-500 bg-indigo-500/10' : 'border-zinc-300/60 dark:border-zinc-700'}`}>
            <input type="radio" name="mode" className="mr-2" checked={form.publishMode === 'auto'} onChange={() => setForm({ ...form, publishMode: 'auto' })} />
            <b>Auto-publish</b>
            <p className="mt-1 text-sm text-zinc-500">New Shorts upload by themselves with the visibility below. Your YouTube daily limits still apply.</p>
          </label>
        </div>
        <Field label="Visibility for uploads" hint="Private is safest while you try auto-publish: you can make a video public on YouTube yourself.">
          <select className={selectCls} value={form.autoVisibility} onChange={(e) => setForm({ ...form, autoVisibility: e.target.value as Settings['autoVisibility'] })} aria-label="Visibility">
            <option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option>
          </select>
        </Field>
        <p className="text-xs text-zinc-500">Changing this only affects Shorts that are not queued yet. Library folder: {form.libraryDir || 'not set'}</p>
        <Button variant="primary" onClick={saveSettings}>Save publishing settings</Button>
      </Card>

      <details className="mb-4">
        <summary className="cursor-pointer text-sm text-zinc-500">Advanced: Gemini (optional, not used by Spikecut; titles and descriptions come from Claude)</summary>
      <Card className="mt-3 mb-4 space-y-3">
        <h2 className="font-semibold">AI (Gemini)</h2>
        <p className="text-sm text-zinc-500">A Gemini API key from Google AI Studio is separate from any Google or Gemini subscription. The key is stored encrypted on this PC and is never shown again or sent to the browser.</p>
        <Field label={form.geminiKeySet ? 'Gemini API key (saved; enter a new one to replace)' : 'Gemini API key'}>
          <input className={inputCls} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} aria-label="Gemini API key" />
        </Field>
        <div className="flex gap-2">
          <Button disabled={key.trim().length < 8} onClick={() => run(async () => { await api.put('/api/settings/gemini-key', { key: key.trim() }); setKey(''); }, 'API key saved')}>Save key</Button>
          {form.geminiKeySet && <Button variant="danger" onClick={() => run(() => api.del('/api/settings/gemini-key'), 'API key removed')}>Remove key</Button>}
        </div>
        <Field label="Model" hint="Which Gemini model writes titles and descriptions. If you get quota or 'no longer available' errors, pick another one from the list and press Test Gemini.">
          <input className={inputCls} list="gemini-models" value={form.geminiModel} onChange={(e) => setForm({ ...form, geminiModel: e.target.value })} />
          <datalist id="gemini-models">
            {['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'].map((m) => <option key={m} value={m} />)}
          </datalist>
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={async () => {
              setTest('running');
              try {
                await api.put('/api/settings', { geminiModel: form.geminiModel }); // test exactly what is typed
                setTest(await api.post('/api/settings/test-gemini'));
              } catch (e) {
                setTest({ ok: false, error: errorText(e) });
              }
            }}
            disabled={test === 'running'}
          >
            {test === 'running' ? <Spinner /> : <Icon name="refresh" />}Test Gemini
          </Button>
          <span className="text-xs text-zinc-500">Sends one tiny text request. No video data.</span>
        </div>
        {test && test !== 'running' && (
          test.ok
            ? <Notice tone="success" className="mb-0">Gemini works with <b>{test.model}</b> (answered in {test.ms} ms).</Notice>
            : <Notice tone="error" className="mb-0"><b>Gemini did not answer.</b> {test.error}{test.hint ? <div className="mt-1">{test.hint}</div> : null}</Notice>
        )}
        <Toggle checked={form.enhanceImports} onChange={(v) => setForm({ ...form, enhanceImports: v })} label="Improve imported titles, descriptions and hashtags with Gemini" />
        <p className="-mt-1 text-xs text-zinc-500">When a clip JSON is imported, Gemini rewrites each title and description and adds more hashtags, using only the facts in the JSON. Only text is sent. Needs the key and the consent below.</p>
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <Toggle checked={form.aiConsent} onChange={(v) => setForm({ ...form, aiConsent: v })} label="Allow sending video frames to Google Gemini" />
          <p className="mt-1 text-amber-900 dark:text-amber-200">When on, a few small still frames sampled from each video (and the file name) leave this computer and are sent to Google to write the title and description. Your video files are never uploaded to the AI provider. When off, no AI generation happens and you can write metadata by hand.</p>
        </div>
      </Card>
      </details>

      <Card className="mb-4 space-y-3">
        <h2 className="font-semibold">Processing</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="AI workers (1-4)" hint="How many videos are analysed at once."><input className={inputCls} type="number" min={1} max={4} value={form.aiWorkers} onChange={num('aiWorkers')} /></Field>
          <Field label="Upload workers (1-2)" hint="Default 1. More can trigger YouTube limits sooner."><input className={inputCls} type="number" min={1} max={2} value={form.uploadWorkers} onChange={num('uploadWorkers')} /></Field>
          <Field label="Wait before a new file is processed (ms)" hint="A file must stop changing for this long, so files still being copied are skipped."><input className={inputCls} type="number" min={100} value={form.stableMs} onChange={num('stableMs')} /></Field>
          <Field label="Rescan folders every (minutes, 0 = off)"><input className={inputCls} type="number" min={0} max={1440} value={form.scanIntervalMin} onChange={num('scanIntervalMin')} /></Field>
        </div>
        <Field label="Temporary folder for extracted frames (blank = system default)" hint="Only Spikecut's own scratch files go here. Your videos are never copied, moved or deleted."><input className={inputCls} value={form.tempDir} onChange={(e) => setForm({ ...form, tempDir: e.target.value })} /></Field>
        <Button variant="primary" onClick={saveSettings}>Save settings</Button>
      </Card>
    </div>
  );
}
