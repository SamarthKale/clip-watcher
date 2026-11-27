import { useState } from 'react';
import { api, errorText } from '../api';
import type { Folder, Profile } from '../types';
import { Button, Card, StatusBadge, Toggle, inputCls, fmtDate } from './ui';
import { ImportJsonButton } from './ImportJson';

export function FolderCard({ folder, profiles, geminiReady, enhanceDefault, onChange, onError }: { folder: Folder; profiles: Profile[]; geminiReady: boolean; enhanceDefault: boolean; onChange: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [enhance, setEnhance] = useState(enhanceDefault);
  const [result, setResult] = useState('');

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api.patch(`/api/folders/${folder.id}`, body);
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const scan = async () => {
    setBusy(true);
    setResult('');
    try {
      const r = await api.post<{ found: number; added: number; changed: number; waiting: number; unavailable: number; metadata?: { applied: number; files: string[] } }>(`/api/folders/${folder.id}/scan`);
      setResult(`Found ${r.found}, new ${r.added}, changed ${r.changed}, still copying ${r.waiting}, unavailable ${r.unavailable}` + (r.metadata?.files.length ? `. Read ${r.metadata.files.join(', ')}: ${r.metadata.applied} updated` : ''));
      onChange();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove "${folder.display_name}" from Spikecut?\n\nYour video files are NOT deleted, and upload history is kept.`)) return;
    try {
      await api.del(`/api/folders/${folder.id}`);
      onChange();
    } catch (e) {
      onError(errorText(e));
    }
  };

  return (
    <Card className="space-y-3" >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium" data-testid="folder-name">{folder.display_name}</div>
          <div className="break-all text-xs text-zinc-500">{folder.path}</div>
        </div>
        <StatusBadge status={folder.available ? 'VALID' : 'UNAVAILABLE'} label={folder.available ? 'available' : 'unavailable (drive disconnected?)'} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-500">AI profile</span>
          <select className={inputCls} value={folder.ai_profile_id ?? ''} onChange={(e) => void patch({ ai_profile_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">None</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-500">Default visibility</span>
          <select className={inputCls} value={folder.default_visibility} onChange={(e) => void patch({ default_visibility: e.target.value })}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
            <option value="private">Private</option>
          </select>
        </label>
        <div className="space-y-1 pt-5">
          <Toggle checked={!!folder.recursive_scan} onChange={(v) => void patch({ recursive_scan: v ? 1 : 0 })} label="Include subfolders" />
          <Toggle checked={!!folder.auto_publish} onChange={(v) => void patch({ auto_publish: v ? 1 : 0 })} label="Auto-publish (no review)" />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={scan} disabled={busy}>{busy ? 'Scanning...' : 'Scan now'}</Button>
        <ImportJsonButton folderId={folder.id} enhance={enhance && geminiReady} onDone={(m) => { setResult(m); onChange(); }} onError={onError} />
        <label className={`flex items-center gap-1.5 text-xs ${geminiReady ? '' : 'opacity-50'}`} title={geminiReady ? 'Gemini rewrites each imported title, description and hashtags using only the facts in the JSON' : 'Add your Gemini key and allow it in Settings to use this'}>
          <input type="checkbox" className="accent-violet-600" checked={enhance && geminiReady} disabled={!geminiReady} onChange={(e) => setEnhance(e.target.checked)} />
          Improve with Gemini
        </label>
        <Button variant="danger" onClick={remove}>Remove from Spikecut</Button>
        <span className="text-xs text-zinc-500">Last scan: {folder.last_scan_at ? fmtDate(folder.last_scan_at) : 'never'}</span>
        {result && <span className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="scan-result">{result}</span>}
      </div>
      <p className="text-xs text-zinc-500">A clip JSON (like clips.json) inside this folder is read automatically on every scan, and its titles, descriptions and hashtags are used. With "Improve with Gemini" on, Gemini then makes each title and description stronger and adds more hashtags, using only the facts in the JSON. Uploads wait for the improved text, and you can restore the original from the Library.</p>
    </Card>
  );
}
