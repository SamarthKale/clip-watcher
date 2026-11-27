import { motion } from 'motion/react';
import { AnimatedNumber, Card, EmptyState, Notice, PageHeader } from '../components/ui';
import { fmtTokens, fmtUsd, pipe, usePipelinePoll, type UsageSummary } from '../pipeline';

function Stat({ label, value, format, sub }: { label: string; value: number | null; format: (n: number) => string; sub?: string }) {
  return (
    <Card lift>
      <div className="text-sm text-zinc-500">{label}</div>
      <div className="font-display mt-1 text-3xl font-semibold leading-none tracking-[-0.02em]">{value == null ? '–' : <AnimatedNumber value={value} format={format} />}</div>
      {sub && <div className="mt-1.5 text-xs text-zinc-500">{sub}</div>}
    </Card>
  );
}

export function Usage() {
  const u = usePipelinePoll(() => pipe.get<UsageSummary>('usage'), 10_000);
  const d = u.data;
  const maxDay = Math.max(0.01, ...(d?.per_day ?? []).map((x) => x.cost_usd));
  return (
    <div>
      <PageHeader title="Claude usage" subtitle="What Claude used to edit each Short: tokens, turns and cost, with failed attempts counted." />
      {u.offline && <Notice tone="warn" className="mb-4">The clipping pipeline is not running.</Notice>}
      {d && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total (list price)" value={d.total.cost_usd} format={fmtUsd} sub={`${d.total.attempts} attempts on ${d.total.videos} videos`} />
            <Stat label="Average per finished Short" value={d.total.avg_per_finished_usd} format={fmtUsd} sub={`${d.total.finished} finished`} />
            <Stat label="Spent on failed attempts" value={d.total.wasted_usd} format={fmtUsd} sub="retries, rejects and invalid edits" />
            <Stat label="Tokens" value={d.total.cache_read + d.total.cache_write + d.total.input_tokens} format={(n) => fmtTokens(Math.round(n))} sub={`${fmtTokens(d.total.output_tokens)} written by Claude`} />
          </div>
          <p className="mb-4 text-xs text-zinc-500">{d.total.note}</p>

          <div className="mb-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <h2 className="font-semibold">Per day</h2>
              {d.per_day.length === 0 ? <div className="py-6 text-center text-sm text-zinc-500">No edits yet.</div> : (
                <div className="mt-3 flex h-36 items-end gap-2">
                  {d.per_day.map((x) => (
                    <div key={x.date} className="flex flex-1 flex-col items-center gap-1" title={`${x.date}: ${fmtUsd(x.cost_usd)}, ${x.attempts} attempts`}>
                      <div className="text-[10px] text-zinc-500">{fmtUsd(x.cost_usd)}</div>
                      <motion.div className="w-full rounded-t bg-gradient-to-t from-indigo-500 to-indigo-400" initial={{ height: 0 }} animate={{ height: Math.max(3, (x.cost_usd / maxDay) * 100) }} transition={{ type: 'spring', stiffness: 160, damping: 22 }} />
                      <div className="text-[10px] text-zinc-500">{x.date.slice(5)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
            <Card>
              <h2 className="mb-2 font-semibold">Per stream</h2>
              {d.per_stream.length === 0 ? <div className="py-6 text-center text-sm text-zinc-500">Nothing yet.</div> : (
                <table className="w-full text-sm"><tbody>
                  {d.per_stream.map((s) => (
                    <tr key={s.channel} className="border-t border-zinc-200/60 first:border-0 dark:border-zinc-700/60">
                      <td className="py-1.5"><b>{s.channel}</b><div className="text-xs text-zinc-500">{s.finished}/{s.videos} finished</div></td>
                      <td className="py-1.5 text-right">{fmtUsd(s.cost_usd)}<div className="text-xs text-zinc-500">{fmtUsd(s.avg_per_finished_usd)} each</div></td>
                    </tr>
                  ))}
                </tbody></table>
              )}
            </Card>
          </div>

          <Card>
            <h2 className="mb-2 font-semibold">Per video</h2>
            {d.videos.length === 0 ? <EmptyState icon="sparkles" title="No usage recorded yet">Each edit is recorded here when it finishes.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs text-zinc-500"><th className="py-1.5 pr-3 font-medium">Clip</th><th className="pr-3 font-medium">Result</th><th className="pr-3 text-right font-medium">Tries</th><th className="pr-3 text-right font-medium">Turns</th><th className="pr-3 text-right font-medium">Tokens in</th><th className="pr-3 text-right font-medium">Tokens out</th><th className="pr-3 text-right font-medium">Time</th><th className="text-right font-medium">Cost</th></tr></thead>
                  <tbody>
                    {d.videos.map((v) => (
                      <tr key={v.event_id} className="border-t border-zinc-200/60 dark:border-zinc-700/60">
                        <td className="py-1.5 pr-3 font-mono text-xs">{v.event_id}<div className="font-sans text-[11px] text-zinc-500">{v.models.join(', ')}</div></td>
                        <td className="pr-3">{v.finished ? 'Finished' : v.outcome}</td>
                        <td className="pr-3 text-right">{v.attempts}</td>
                        <td className="pr-3 text-right">{v.turns}</td>
                        <td className="pr-3 text-right">{fmtTokens(v.input_tokens + v.cache_read + v.cache_write)}</td>
                        <td className="pr-3 text-right">{fmtTokens(v.output_tokens)}</td>
                        <td className="pr-3 text-right">{Math.round(v.duration_s / 60)} min</td>
                        <td className="text-right font-medium">{fmtUsd(v.cost_usd)}{v.wasted_usd > 0 && <div className="text-[11px] font-normal text-amber-500">{fmtUsd(v.wasted_usd)} wasted</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
