import { useRef, useState } from 'react';
import { api, errorText } from '../api';
import { Button, Icon } from './ui';

interface ImportResult {
  matched: number;
  applied: number;
  unchanged: number;
  skipped: number;
  unmatched: string[];
  errors: { file: string; reason: string }[];
  enhanceQueued?: number;
  enhanceSkipped?: string;
}

export function summarize(r: ImportResult): string {
  const parts = [`${r.applied} updated`];
  if (r.enhanceQueued) parts.push(`${r.enhanceQueued} being improved with Gemini`);
  if (r.enhanceSkipped) parts.push(r.enhanceSkipped);
  if (r.unchanged) parts.push(`${r.unchanged} already up to date`);
  if (r.skipped) parts.push(`${r.skipped} left alone (uploaded, uploading or edited by you)`);
  if (r.unmatched.length) parts.push(`${r.unmatched.length} entries had no video in this folder`);
  if (r.errors.length) parts.push(`${r.errors.length} rejected: ${r.errors.slice(0, 2).map((e) => `${e.file} (${e.reason})`).join('; ')}${r.errors.length > 2 ? '...' : ''}`);
  return parts.join(', ');
}

/** Picks a clip JSON on this computer and applies its titles, descriptions and hashtags to a folder's videos. */
export function ImportJsonButton({ folderId, disabled, enhance, onDone, onError }: { folderId: number | null; disabled?: boolean; enhance?: boolean; onDone: (summary: string) => void; onError: (m: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file || folderId === null) return;
    setBusy(true);
    try {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not valid JSON`);
      }
      const r = await api.post<ImportResult>(`/api/folders/${folderId}/import-metadata${enhance ? '?enhance=1' : ''}`, json);
      onDone(`${file.name}: ${summarize(r)}`);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="Clip JSON file" onChange={(e) => void pick(e.target.files?.[0])} />
      <Button disabled={disabled || busy || folderId === null} onClick={() => input.current?.click()}>
        <Icon name="file" />{busy ? 'Importing...' : 'Import metadata JSON'}
      </Button>
    </>
  );
}
