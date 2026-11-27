import { useEffect, useMemo, useState } from 'react';
import { api, errorText } from '../api';
import { MetadataEditor } from '../components/MetadataEditor';
import { ImportJsonButton } from '../components/ImportJson';
import { Button, EmptyState, ErrorBanner, Icon, PageHeader, SourceChip, StatusBadge, fmtDuration, fmtSize, inputCls, selectCls, usePoll } from '../components/ui';
import type { Folder, Settings, VideoRow } from '../types';

const thumbCache = new Map<number, string>();

function Thumb({ id }: { id: number }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(id) ?? null);
  useEffect(() => {
    if (url) return;
    let alive = true;
    api.blob(`/api/videos/${id}/thumbnail`).then((b) => {
      const u = URL.createObjectURL(b);
      thumbCache.set(id, u);
      if (alive) setUrl(u);
    }, () => undefined);
    return () => { alive = false; };
  }, [id, url]);
  return url ? <img src={url} alt="" className="h-14 w-9 rounded object-cover" /> : <div className="h-14 w-9 rounded bg-zinc-200 dark:bg-zinc-800" />;
}

type SortKey = 'filename' | 'duration_seconds' | 'file_size_bytes' | 'id';
const PAGE = 200;

export function Library() {
  const [f, setF] = useState({ folderId: '', metadataStatus: '', approvalStatus: '', uploadStatus: '', errorsOnly: false, text: '' });
  const qs = new URLSearchParams();
  if (f.folderId) qs.set('folderId', f.folderId);
  if (f.metadataStatus) qs.set('metadataStatus', f.metadataStatus);
  if (f.approvalStatus) qs.set('approvalStatus', f.approvalStatus);
  if (f.uploadStatus) qs.set('uploadStatus', f.uploadStatus);
  if (f.errorsOnly) qs.set('errorsOnly', '1');
  const list = usePoll(() => api.get<{ videos: VideoRow[] }>(`/api/videos?${qs}`), 3000);
  const folders = usePoll(() => api.get<Folder[]>('/api/folders'), 15000);
  const settings = usePoll(() => api.get<Settings>('/api/settings'), 20000);
  const geminiReady = !!settings.data?.geminiKeySet && !!settings.data?.aiConsent;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'id', dir: -1 });
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const rows = useMemo(() => {
    const t = f.text.trim().toLowerCase();
    const filtered = (list.data?.videos ?? []).filter((v) => !t || v.filename.toLowerCase().includes(t) || (v.title ?? '').toLowerCase().includes(t));
    return [...filtered].sort((a, b) => {
      const x = a[sort.key] ?? 0, y = b[sort.key] ?? 0;
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [list.data, f.text, sort]);

  // The folder a JSON import applies to: the one chosen in the filter, or the only folder there is.
  const importFolder = f.folderId ? Number(f.folderId) : folders.data?.length === 1 ? folders.data[0].id : null;
  const ids = [...selected];
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allVisible = rows.slice(0, shown).map((r) => r.id);
  const bulk = async (label: string, fn: () => Promise<unknown>) => {
    setError(null); setNote('');
    try { await fn(); if (label) setNote(label); list.reload(); } catch (e) { setError(errorText(e)); }
  };
  const header = (key: SortKey, label: string) => (
    <button className="font-medium hover:underline" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </button>
  );
  const editingVideo = list.data?.videos.find((v) => v.id === editing);

  return (
    <div>
      <PageHeader title="Video Library" subtitle="Every video LocalTube has found, with its title, description and upload state. Click a filename to edit it.">
        <ImportJsonButton folderId={importFolder} enhance={geminiReady && (settings.data?.enhanceImports ?? false)} onDone={(m) => { setNote(m); list.reload(); }} onError={setError} />
      </PageHeader>
      {importFolder === null && folders.data && folders.data.length > 1 && <p className="mb-2 text-xs text-zinc-500">To import a metadata JSON here, first choose a folder in the folder filter.</p>}
      <ErrorBanner error={error ?? list.error} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <input className={`${inputCls} max-w-56`} placeholder="Search filename or title" aria-label="Search" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        <select className={selectCls} aria-label="Folder" value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}>
          <option value="">All folders</option>
          {folders.data?.map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}
        </select>
        <select className={selectCls} aria-label="Metadata status" value={f.metadataStatus} onChange={(e) => setF({ ...f, metadataStatus: e.target.value })}>
          <option value="">Any metadata</option>
          {['NOT_STARTED', 'ANALYZING', 'GENERATING', 'READY', 'STALE', 'FAILED'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={selectCls} aria-label="Approval status" value={f.approvalStatus} onChange={(e) => setF({ ...f, approvalStatus: e.target.value })}>
          <option value="">Any approval</option>
          {['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select className={selectCls} aria-label="Upload status" value={f.uploadStatus} onChange={(e) => setF({ ...f, uploadStatus: e.target.value })}>
          <option value="">Any upload state</option>
          {['NOT_QUEUED', 'QUEUED', 'UPLOADING', 'UPLOAD_COMPLETE', 'FAILED_PERMANENTLY', 'UPLOAD_OUTCOME_UNKNOWN'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={f.errorsOnly} onChange={(e) => setF({ ...f, errorsOnly: e.target.checked })} /> Errors only</label>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="Bulk actions">
        <span className="text-sm text-zinc-500">{ids.length} selected</span>
        <Button disabled={!ids.length} onClick={() => bulk('Queued for metadata generation', () => api.post('/api/videos/regenerate', { ids }))}>Generate / regenerate metadata</Button>
        <Button variant="soft" disabled={!ids.length || !geminiReady} title={geminiReady ? 'Gemini rewrites the selected titles and descriptions and adds hashtags' : 'Add your Gemini key and allow it in Settings first'} onClick={() => bulk('', async () => { const r = await api.post<{ queued: number }>('/api/videos/enhance', { ids }); setNote(r.queued ? `${r.queued} sent to Gemini to improve. Uploads wait for it.` : 'Nothing to improve: those videos are uploaded, written by you, or have no text yet.'); })}><Icon name="sparkles" />Improve with Gemini</Button>
        <Button disabled={!ids.length} onClick={() => bulk('Approved', () => api.post('/api/videos/approve', { ids }))}>Approve</Button>
        <Button disabled={!ids.length} onClick={() => bulk('Rejected', () => api.post('/api/videos/reject', { ids }))}>Reject / skip</Button>
        <Button variant="primary" disabled={!ids.length} onClick={() => bulk('', async () => { const r = await api.post<{ queued: number }>('/api/queue/enqueue', { ids }); setNote(`${r.queued} added to the upload queue`); })}>Add to upload queue</Button>
        {note && <span className="text-sm text-emerald-600">{note}</span>}
      </div>
      {list.data && rows.length === 0 && <EmptyState icon="film" title="No videos match">Add a folder and scan it, or clear the filters above.</EmptyState>}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 shadow-sm dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="p-2"><input type="checkbox" aria-label="Select all" checked={allVisible.length > 0 && allVisible.every((i) => selected.has(i))} onChange={(e) => setSelected(e.target.checked ? new Set(allVisible) : new Set())} /></th>
              <th className="p-2" />
              <th className="p-2">{header('filename', 'Filename')}</th>
              <th className="hidden p-2 2xl:table-cell">Folder</th>
              <th className="p-2">{header('duration_seconds', 'Duration')}</th>
              <th className="hidden p-2 xl:table-cell">{header('file_size_bytes', 'Size')}</th>
              <th className="p-2">Title</th>
              <th className="p-2">AI</th>
              <th className="p-2">Approval</th>
              <th className="p-2">Upload</th>
              <th className="p-2">YouTube</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.slice(0, shown).map((v) => (
              <tr key={v.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60" data-testid="video-row">
                <td className="p-2"><input type="checkbox" aria-label={`Select ${v.filename}`} checked={selected.has(v.id)} onChange={() => toggle(v.id)} /></td>
                <td className="p-2"><Thumb id={v.id} /></td>
                <td className="p-2"><button className="block max-w-[14rem] truncate text-left font-medium text-indigo-600 hover:underline" title={v.filename} onClick={() => setEditing(v.id)}>{v.filename}</button>{v.discovery_status !== 'VALID' && <div><StatusBadge status={v.discovery_status} /></div>}</td>
                <td className="hidden p-2 2xl:table-cell">{v.folder_name}</td>
                <td className="p-2">{fmtDuration(v.duration_seconds)}</td>
                <td className="hidden p-2 xl:table-cell">{fmtSize(v.file_size_bytes)}</td>
                <td className="max-w-72 p-2"><div className="truncate" title={v.title ?? ''}>{v.title ?? <span className="text-zinc-400">none yet</span>}</div><div className="mt-1"><SourceChip source={v.metadata_source} enhance={v.enhance_status} /></div></td>
                <td className="p-2"><StatusBadge status={v.metadata_status} /></td>
                <td className="p-2"><StatusBadge status={v.approval_status} /></td>
                <td className="p-2"><StatusBadge status={v.upload_status} />{v.last_error && <div className="max-w-48 truncate text-xs text-red-600" title={v.last_error}>{v.last_error}</div>}</td>
                <td className="p-2">{v.youtube_url ? <a className="text-indigo-600 underline" href={v.youtube_url} target="_blank" rel="noreferrer">open</a> : ''}{v.upload_status === 'UPLOAD_COMPLETE' && <div><StatusBadge status={v.processing_status} /></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && <div className="mt-3"><Button onClick={() => setShown(shown + PAGE)}>Show more ({rows.length - shown} more)</Button></div>}
      {editingVideo && <MetadataEditor video={editingVideo} onClose={() => setEditing(null)} onChange={list.reload} />}
    </div>
  );
}
