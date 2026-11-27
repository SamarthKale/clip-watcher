import { useState } from 'react';
import { api, download, errorText } from '../api';
import { Button, ErrorBanner, PageHeader, StatusBadge, inputCls, selectCls, usePoll, fmtDate } from '../components/ui';
import type { HistoryRow } from '../types';

export function History() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (text) qs.set('text', text);
  if (status) qs.set('status', status);
  qs.set('pageSize', '200');
  const h = usePoll(() => api.get<{ rows: HistoryRow[] }>(`/api/history?${qs}`), 5000);

  return (
    <div>
      <PageHeader title="Upload History">
        <Button onClick={() => download(`/api/history.csv?${qs}`, 'localtube-history.csv').catch((e) => setError(errorText(e)))}>Export CSV</Button>
      </PageHeader>
      <ErrorBanner error={error ?? h.error} />
      <div className="mb-3 flex flex-wrap gap-2">
        <input className={`${inputCls} max-w-64`} placeholder="Search title, file or YouTube id" aria-label="Search history" value={text} onChange={(e) => setText(e.target.value)} />
        <select className={selectCls} aria-label="Result" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any result</option>
          {['UPLOAD_COMPLETE', 'UPLOADING', 'QUEUED', 'RETRY_WAIT', 'BLOCKED_BY_QUOTA', 'FAILED_PERMANENTLY', 'UPLOAD_OUTCOME_UNKNOWN', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {h.data && h.data.rows.length === 0 && <p className="text-zinc-500">No uploads recorded yet.</p>}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 dark:bg-zinc-900">
            <tr>{['File', 'Folder', 'Channel', 'Title', 'Uploaded', 'Result', 'YouTube', 'Visibility', 'Error'].map((c) => <th key={c} className="p-2 font-medium">{c}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {h.data?.rows.map((r) => (
              <tr key={r.job_id}>
                <td className="p-2">{r.filename}</td>
                <td className="p-2">{r.folder}</td>
                <td className="p-2">{r.channel_title}</td>
                <td className="max-w-56 truncate p-2" title={r.title}>{r.title}</td>
                <td className="p-2">{fmtDate(r.upload_completed_at)}</td>
                <td className="p-2"><StatusBadge status={r.result} />{r.result === 'UPLOAD_COMPLETE' && <div><StatusBadge status={r.published ? 'READY' : r.processing_status} label={r.published ? 'published' : undefined} /></div>}</td>
                <td className="p-2">{r.youtube_url ? <a className="text-indigo-600 underline" href={r.youtube_url} target="_blank" rel="noreferrer">{r.youtube_url.replace('https://', '')}</a> : ''}</td>
                <td className="p-2">{r.visibility}</td>
                <td className="max-w-48 truncate p-2 text-red-600" title={r.last_error}>{r.last_error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
