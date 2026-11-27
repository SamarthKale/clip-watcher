import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { Button, Card, ErrorBanner, Field, PageHeader, inputCls, usePoll } from '../components/ui';
import type { Profile } from '../types';

type Draft = Omit<Profile, 'id' | 'prompt_version'>;
const blank: Draft = { name: 'New profile', title_prompt: '', description_prompt: '', hashtag_prompt: '', fixed_hashtags: '["#Shorts"]', language: 'en', tone: '', target_audience: '' };

export function Profiles() {
  const list = usePoll(() => api.get<Profile[]>('/api/profiles'), 10000);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const current = list.data?.find((p) => p.id === selected);
  useEffect(() => {
    if (!current) return;
    const { id: _i, prompt_version: _v, ...rest } = current;
    setDraft(rest);
    try { setTags((JSON.parse(current.fixed_hashtags) as string[]).join(' ')); } catch { setTags(''); }
  }, [current?.id, current?.prompt_version, current?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selected === null && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected]);

  const set = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const fixedJson = () => JSON.stringify(tags.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : `#${t}`)));

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try { await fn(); list.reload(); } catch (e) { setError(errorText(e)); }
  };
  const save = () => run(async () => {
    const body = { ...draft, fixed_hashtags: fixedJson() };
    if (selected === null) { const p = await api.post<Profile>('/api/profiles', body); setSelected(p.id); }
    else await api.put(`/api/profiles/${selected}`, body);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  });

  return (
    <div>
      <PageHeader title="AI Profiles">
        <Button onClick={() => { setSelected(null); setDraft(blank); setTags('#Shorts'); }}>New profile</Button>
      </PageHeader>
      <ErrorBanner error={error ?? list.error} />
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          <ul className="space-y-1">
            {list.data?.map((p) => (
              <li key={p.id}>
                <button onClick={() => setSelected(p.id)} className={`w-full rounded-md px-3 py-2 text-left text-sm ${selected === p.id ? 'bg-indigo-600 text-white' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
                  {p.name} <span className="opacity-70">v{p.prompt_version}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="space-y-3">
          <Field label="Profile name"><input className={inputCls} value={draft.name} onChange={(e) => set('name', e.target.value)} /></Field>
          <Field label="Title instructions" hint="How titles should be written for videos in folders using this profile."><textarea className={inputCls} rows={3} value={draft.title_prompt} onChange={(e) => set('title_prompt', e.target.value)} /></Field>
          <Field label="Description instructions"><textarea className={inputCls} rows={3} value={draft.description_prompt} onChange={(e) => set('description_prompt', e.target.value)} /></Field>
          <Field label="Hashtag instructions"><textarea className={inputCls} rows={2} value={draft.hashtag_prompt} onChange={(e) => set('hashtag_prompt', e.target.value)} /></Field>
          <Field label="Fixed hashtags" hint="Always added, separated by spaces."><input className={inputCls} value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Language"><input className={inputCls} value={draft.language} onChange={(e) => set('language', e.target.value)} /></Field>
            <Field label="Tone / style"><input className={inputCls} value={draft.tone} onChange={(e) => set('tone', e.target.value)} /></Field>
            <Field label="Target audience"><input className={inputCls} value={draft.target_audience} onChange={(e) => set('target_audience', e.target.value)} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={save}>Save profile</Button>
            {selected !== null && <Button onClick={() => run(async () => { const p = await api.post<Profile>(`/api/profiles/${selected}/duplicate`); setSelected(p.id); })}>Duplicate</Button>}
            {selected !== null && <Button variant="danger" onClick={() => { if (confirm('Delete this profile?')) void run(async () => { await api.del(`/api/profiles/${selected}`); setSelected(null); }); }}>Delete</Button>}
            {saved && <span className="text-sm text-emerald-600">Saved</span>}
            {current && <span className="text-xs text-zinc-500">Prompt version {current.prompt_version}: bumps whenever the instructions change.</span>}
          </div>
        </Card>
      </div>
    </div>
  );
}
