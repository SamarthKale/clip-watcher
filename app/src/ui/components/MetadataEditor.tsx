import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { VideoRow } from '../types';
import { Button, ErrorBanner, Field, Icon, SourceChip, StatusBadge, inputCls } from './ui';

const parseTags = (s: string) => s.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`));

export function MetadataEditor({ video, onClose, onChange }: { video: VideoRow; onClose: () => void; onChange: () => void }) {
  const [title, setTitle] = useState(video.title ?? '');
  const [description, setDescription] = useState(video.description ?? '');
  const [tags, setTags] = useState(() => { try { return (JSON.parse(video.hashtags_json ?? '[]') as string[]).join(' '); } catch { return ''; } });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  // Reload the fields when AI regeneration (or a rescan) changes what is stored.
  useEffect(() => {
    setTitle(video.title ?? '');
    setDescription(video.description ?? '');
    try { setTags((JSON.parse(video.hashtags_json ?? '[]') as string[]).join(' ')); } catch { setTags(''); }
  }, [video.id, video.title, video.description, video.hashtags_json]);

  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name); setError(null); setNote('');
    try { await fn(); if (ok) setNote(ok); onChange(); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save'); setError(null); setNote('');
    try {
      const r = await api.put<{ warning?: string }>(`/api/videos/${video.id}/metadata`, { title, description, hashtags: parseTags(tags) });
      setNote(r.warning ? `Saved. ${r.warning}` : 'Saved');
      onChange();
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const regen = (only?: 'title' | 'description' | 'hashtags') => run(`regen-${only ?? 'all'}`, () => api.post(`/api/videos/${video.id}/regenerate`, only ? { only } : {}));

  const improve = () => run('improve', () => api.post(`/api/videos/${video.id}/enhance`), 'Improved with Gemini');
  const restore = () => run('restore', () => api.post(`/api/videos/${video.id}/restore-original`), 'Original text restored');
  const uploaded = ['UPLOADING', 'UPLOAD_COMPLETE', 'UPLOAD_OUTCOME_UNKNOWN'].includes(video.upload_status);

  const warnings: string[] = [];
  if (video.shorts_warning) warnings.push(video.shorts_warning);
  if (video.confidence === 'low') warnings.push('The AI had low confidence in this result. Please review it.');
  if (video.needs_review) warnings.push('The AI flagged this for review.');
  if (video.metadata_status === 'STALE') warnings.push('The video file changed after this metadata was written. Regenerate it.');

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <aside role="dialog" aria-label="Edit metadata" className="h-full w-full max-w-xl overflow-y-auto bg-white p-5 shadow-xl dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{video.filename}</h2>
            <div className="text-xs text-zinc-500">{video.folder_name}{video.ai_profile ? ` · profile: ${video.ai_profile}` : ''}</div>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
        </div>
        <div className="mb-3 flex flex-wrap gap-1"><SourceChip source={video.metadata_source} enhance={video.enhance_status} /><StatusBadge status={video.metadata_status} label={`metadata ${video.metadata_status.toLowerCase()}`} /><StatusBadge status={video.approval_status} label={`approval ${video.approval_status.toLowerCase().replace('_', ' ')}`} /><StatusBadge status={video.upload_status} /></div>
        <ErrorBanner error={error ?? video.last_error} />
        {warnings.map((w) => <div key={w} className="mb-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{w}</div>)}
        <div className="space-y-3">
          <Field label={`Title (${title.length}/100)`}>
            <input className={inputCls} maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Description"><textarea className={inputCls} rows={6} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Hashtags" hint="Separated by spaces. A # is added if missing."><input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => regen('title')} disabled={!!busy}>{busy === 'regen-title' ? '...' : 'Regenerate title'}</Button>
          <Button onClick={() => regen('description')} disabled={!!busy}>{busy === 'regen-description' ? '...' : 'Regenerate description'}</Button>
          <Button onClick={() => regen('hashtags')} disabled={!!busy}>{busy === 'regen-hashtags' ? '...' : 'Regenerate hashtags'}</Button>
          <Button variant="soft" onClick={improve} disabled={!!busy || uploaded || !video.title} title="Gemini rewrites the title and description and adds more hashtags, using only the facts already here"><Icon name="sparkles" />{busy === 'improve' ? 'Improving...' : 'Improve with Gemini'}</Button>
          {video.metadata_source === 'manifest-ai' && <Button onClick={restore} disabled={!!busy || uploaded}><Icon name="undo" />{busy === 'restore' ? '...' : 'Restore original'}</Button>}
        </div>
        <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
          <div className="mb-1 text-xs uppercase text-zinc-500">Preview on YouTube</div>
          <div className="font-semibold">{title || '(no title)'}</div>
          <div className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{description}{parseTags(tags).length ? `\n\n${parseTags(tags).join(' ')}` : ''}</div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" onClick={save} disabled={!!busy || !title.trim()}>Save changes</Button>
          <Button onClick={() => run('approve', () => api.post('/api/videos/approve', { ids: [video.id] }), 'Approved')} disabled={!!busy || video.metadata_status !== 'READY'}>Approve for upload</Button>
          {video.discovery_status === 'DUPLICATE' && (
            <Button variant="danger" onClick={() => { if (confirm('This file is identical to another video. Publish it again anyway?')) void run('republish', () => api.post(`/api/videos/${video.id}/allow-republish`)); }}>Allow republish</Button>
          )}
          {note && <span className="text-sm text-emerald-600">{note}</span>}
        </div>
      </aside>
    </div>
  );
}
