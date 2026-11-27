import { useState } from 'react';
import { api, errorText } from '../api';
import { FolderCard } from '../components/FolderCard';
import { Button, ErrorBanner, PageHeader, inputCls, usePoll } from '../components/ui';
import type { Folder, Profile, Settings } from '../types';

export function Folders() {
  const folders = usePoll(() => api.get<Folder[]>('/api/folders'), 4000);
  const profiles = usePoll(() => api.get<Profile[]>('/api/profiles'), 30000);
  const settings = usePoll(() => api.get<Settings>('/api/settings'), 15000);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const add = async () => {
    setError(null);
    try {
      await api.post('/api/folders/pick'); // opens the Windows folder dialog on this PC; 204 if cancelled
      folders.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const addManual = async () => {
    setError(null);
    try {
      await api.post('/api/folders', { path: manual.trim() });
      setManual('');
      folders.reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div>
      <PageHeader title="Folders">
        <Button variant="primary" onClick={add}>Add folder</Button>
      </PageHeader>
      <ErrorBanner error={error ?? folders.error} />
      <p className="mb-4 text-sm text-zinc-500">LocalTube only looks inside folders you add here. A folder is a source: scanning finds videos, and publishing follows each folder's own settings. Removing a folder never deletes your files.</p>
      <div className="mb-5 flex gap-2">
        <input className={inputCls} placeholder="Or type a folder path, e.g. D:\Shorts" aria-label="Folder path" value={manual} onChange={(e) => setManual(e.target.value)} />
        <Button onClick={addManual} disabled={!manual.trim()}>Add path</Button>
      </div>
      {folders.data && folders.data.length === 0 && <p className="text-zinc-500">No folders yet. Click "Add folder" to choose one.</p>}
      <div className="space-y-3">
        {folders.data?.map((f) => (
          <FolderCard key={`${f.id}-${settings.data ? 1 : 0}`} folder={f} profiles={profiles.data ?? []} geminiReady={!!settings.data?.geminiKeySet && !!settings.data?.aiConsent} enhanceDefault={settings.data?.enhanceImports ?? true} onChange={folders.reload} onError={setError} />
        ))}
      </div>
    </div>
  );
}
