import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from './api';

/** Everything the clipping pipeline reports, through the app server (never straight from the browser). */
export interface PipelineState {
  now: number;
  channel: string;
  channel_url: string;
  pipeline: { running: boolean; owned: boolean; channel: string | null; since: number | null; chat_age: number | null; mode?: 'live' | 'links' | null };
  live: boolean;
  live_since: number | null;
  stats: { spikes_today: number; shorts_today: number; shorts_total: number; queue: { waiting: number; editing: number } };
  activity: { date: string; spikes: number; shorts: number }[];
  events: SpikeRow[];
}
export interface SpikeRow {
  id: string;
  channel: string;
  spike_ts: number;
  state: string;
  tone: 'ok' | 'warn' | 'bad' | 'live' | 'wait';
  open_stage: string | null;
  failed: boolean;
  messages: number | null;
  baseline: number | null;
  ratio: number | null;
  error: string;
}
export interface ChatState {
  connected: boolean;
  buckets: number[];
  baseline: number;
  threshold: number;
  messages: { t: number; name: string; text: string }[];
}
export interface ShortRow {
  event_id: string;
  channel: string;
  date: string;
  duration: number;
  size_mb: number;
  made: number;
  title: string;
  logline: string | null;
  moment: string | null;
  score: number | null;
  has_thumb: boolean;
  folder: string;
}
export interface LogLine { ts: string; level: string; stage: string; msg: string }
export interface UsageSummary {
  total: { videos: number; finished: number; attempts: number; cost_usd: number; wasted_usd: number; avg_per_finished_usd: number | null; turns: number; output_tokens: number; cache_read: number; cache_write: number; input_tokens: number; note: string };
  per_day: { date: string; attempts: number; cost_usd: number }[];
  per_stream: { channel: string; videos: number; finished: number; cost_usd: number; avg_per_finished_usd: number | null }[];
  videos: { event_id: string; finished: boolean; outcome: string; attempts: number; turns: number; cost_usd: number; wasted_usd: number; input_tokens: number; cache_read: number; cache_write: number; output_tokens: number; duration_s: number; models: string[] }[];
}
export interface VodData {
  jobs: { id: number; url: string; platform: string; status: string; note: string | null; error: string | null; events: number; source: string; max_shorts?: number }[];
  watch: { id: number; platform: string; channel: string; keyword: string; lookback_hours: number; enabled: number; last_checked: number | null }[];
}
export interface StorageItem {
  id: string; kind: string; label: string; path: string; size: number; age_days: number;
  safe: boolean; reason: string; overridable: boolean; state: string; event_id: string;
}
export interface StorageSummary {
  items: StorageItem[]; by_kind: Record<string, number>; total_bytes: number;
  disks: Record<string, { path: string; free_bytes: number; total_bytes: number }>;
}
export interface StoragePlan {
  delete: StorageItem[]; blocked: StorageItem[]; free_bytes: number; total_bytes: number; older_than_days: number;
}

export interface SetupStatus { tools: { name: string; path: string | null; ok: boolean; hint: string; needed_for: string }[]; ok: boolean; backup_drive: { path: string; ok: boolean; why: string } | null }

export const pipe = {
  get: <T,>(name: string, q = '') => api.get<T>(`/api/pipeline/${name}${q}`),
  post: <T,>(name: string, body: unknown = {}) => api.post<T>(`/api/pipeline/${name}`, body),
};

/** Like usePoll, but a stopped pipeline (502) is a normal state, not an error banner. */
export function usePipelinePoll<T>(load: () => Promise<T>, ms = 3000): { data: T | null; offline: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(load);
  ref.current = load;
  const reload = useCallback(() => {
    ref.current().then(
      (d) => { setData(d); setOffline(false); setError(null); },
      (e) => {
        const msg = errorText(e);
        if (/pipeline offline/i.test(msg)) setOffline(true);
        else setError(msg);
      },
    );
  }, []);
  useEffect(() => {
    reload();
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms]);
  return { data, offline, error, reload };
}

export const fmtUsd = (n: number | null | undefined) => (n == null ? '–' : `$${n.toFixed(2)}`);
export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
export const fmtBytes = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`);
export const fmtClock = (t: number | null | undefined) => (t ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
