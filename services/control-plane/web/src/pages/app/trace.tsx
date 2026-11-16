/**
 * One trace as a waterfall: the request or job that started it, every call
 * it made nested under its caller, its log lines and errors on the same
 * timeline, and what a selected row carried.
 */
import { useAtomValue } from '@effect/atom-react';
import { SLOW_TRACE_MS, TRACE_SAMPLE_RATE } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { Copy, ScrollText } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { stackFrames } from '../../components/logs/log-drawer.tsx';
import { EmptyState, Loaded, Mono, PageHeader, Panel, StatusPill } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { family } from '../../data/atoms.ts';
import { fmtMs, fmtNum } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { timeFormat } from '../../lib/time.ts';
import { layoutTrace, type TraceRow } from '../../lib/trace.ts';
import { cn } from '../../lib/utils.ts';
import { traceRoute } from '../../router.tsx';

// A finished trace doesn't change, and each read runs a Logs Insights query.
const traceAtom = family((k: { app: string; stage: string; trace: string }) =>
  fresh(
    ApiClient.query('observe', 'trace', {
      params: { app: k.app, trace: k.trace },
      query: { stage: k.stage, range: '7d' },
      timeToLive,
    }),
    {
      staleTime: '10 minutes',
    },
  ),
);

const BAR: Record<TraceRow['kind'], string> = {
  req: 'bg-[#4a5568]',
  job: 'bg-[#4a5568]',
  span: 'bg-[var(--chart-1)]',
  log: 'bg-subtle',
  err: 'bg-bad-mark',
  other: 'bg-subtle',
};

/** Round tick steps for the ruler: about five across the trace. */
function ticks(total: number): number[] {
  const raw = total / 5;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = 0; t <= total; t += step) out.push(t);
  return out;
}

export function TracePage() {
  const { app, trace } = traceRoute.useParams();
  const stage = useStage();
  const result = useAtomValue(traceAtom({ app, stage, trace }));
  return (
    <Loaded result={result}>
      {(t) =>
        t.events.length === 0 ? (
          <>
            <PageHeader title={<Mono className="text-xl">{trace}</Mono>} />
            <Panel>
              <EmptyState title="No events with this trace id in the last 7 days">
                Check the stage (traces are per stage), or that the id is complete.
              </EmptyState>
            </Panel>
          </>
        ) : (
          <TraceView app={app} trace={trace} events={t.events} />
        )
      }
    </Loaded>
  );
}

function TraceView({
  app,
  trace,
  events,
}: {
  app: string;
  trace: string;
  events: Parameters<typeof layoutTrace>[0];
}) {
  const { utc } = usePrefs();
  const layout = layoutTrace(events);
  const root = layout.rows.find((r) => r.kind === 'req' || r.kind === 'job') ?? layout.rows[0]!;
  const [selectedKey, setSelectedKey] = useState(root.key);
  const selected = layout.rows.find((r) => r.key === selectedKey) ?? root;
  const when = timeFormat(utc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const recorded = layout.rows.some((r) => r.kind === 'span');
  const logs = layout.rows.filter((r) => r.kind === 'log' || r.kind === 'err');

  return (
    <>
      <PageHeader
        title={
          <>
            <span className="font-mono text-base font-medium text-muted-foreground">{root.op}</span>
            <span className="min-w-0 truncate">{root.label}</span>
            <StatusPill tone={root.failed ? 'bad' : 'ok'}>{root.failed ? 'failed' : 'ok'}</StatusPill>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                <Link
                  to="/apps/$app/logs"
                  params={{ app }}
                  search={(prev) => ({ ...prev, f: { trace }, range: '7d', from: undefined, to: undefined })}
                />
              }
            >
              <ScrollText />
              Its logs
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(trace).then(
                  () => toast.success('Copied the trace id'),
                  () => toast.error("Couldn't copy to the clipboard"),
                )
              }
            >
              <Copy />
              Copy id
            </Button>
          </>
        }
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Mono className="text-foreground">{trace}</Mono>
          <span className="text-subtle">·</span>
          <span>{when(layout.t0)}</span>
          <span className="text-subtle">·</span>
          <span className="tabular">{fmtMs(layout.total)}</span>
          <span className="text-subtle">·</span>
          <span>
            deployment <Mono>{root.event.rev.slice(-7)}</Mono>
          </span>
        </div>
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[1fr_24rem]">
        <Panel
          flush
          title="Waterfall"
          description={`${fmtNum(layout.rows.length)} events over ${fmtMs(layout.total)}`}
        >
          <div className="px-4 pb-2">
            <div className="grid grid-cols-[minmax(14rem,2fr)_3fr_4.5rem] items-end gap-3 border-b pb-1.5 text-[11px] text-muted-foreground">
              <span>Event</span>
              <div className="relative h-4">
                {ticks(layout.total).map((t) => (
                  <span
                    key={t}
                    className="absolute top-0 -translate-x-1/2 font-mono tabular first:translate-x-0"
                    style={{ left: `${(t / layout.total) * 100}%` }}
                  >
                    {t === 0 ? '0' : fmtMs(t)}
                  </span>
                ))}
              </div>
              <span className="text-right">Duration</span>
            </div>
            <ul aria-label="Trace events">
              {layout.rows.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(r.key)}
                    aria-current={r.key === selected.key || undefined}
                    className="grid w-full grid-cols-[minmax(14rem,2fr)_3fr_4.5rem] items-center gap-3 rounded-sm py-1 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent aria-current:bg-accent"
                  >
                    <span
                      className="flex min-w-0 items-center gap-1.5 text-[13px]"
                      style={{ paddingLeft: r.depth * 14 }}
                    >
                      {r.depth > 0 && (
                        <span aria-hidden className="-mt-2 h-3 w-2 shrink-0 border-b border-l border-input" />
                      )}
                      <span
                        className={cn(
                          'shrink-0 font-mono text-[11.5px]',
                          r.failed ? 'text-bad' : 'text-muted-foreground',
                        )}
                      >
                        {r.op}
                      </span>
                      <span className="truncate">{r.label}</span>
                    </span>
                    <span className="relative h-3.5 rounded-sm bg-[repeating-linear-gradient(90deg,transparent_0,transparent_calc(20%-1px),var(--chart-grid)_calc(20%-1px),var(--chart-grid)_20%)]">
                      {r.dur > 0 ? (
                        <span
                          className={cn(
                            'absolute top-0.5 h-2.5 rounded-[2px]',
                            r.failed && r.kind === 'span' ? 'bg-bad-mark' : BAR[r.kind],
                          )}
                          style={{
                            left: `${(r.start / layout.total) * 100}%`,
                            width: `max(2px, ${(r.dur / layout.total) * 100}%)`,
                          }}
                        />
                      ) : (
                        <span
                          aria-hidden
                          className={cn(
                            'absolute top-0.5 size-2.5 -translate-x-1/2 rotate-45 rounded-[1px]',
                            r.kind === 'err' ? 'bg-bad' : 'bg-muted-foreground',
                          )}
                          style={{ left: `${(r.start / layout.total) * 100}%` }}
                        />
                      )}
                    </span>
                    <span className="text-right font-mono text-[12px] text-muted-foreground tabular">
                      {r.dur > 0 ? fmtMs(r.dur) : ''}
                    </span>
                  </button>
                  {r.unrecorded && (
                    <p
                      className="pb-1 text-xs text-muted-foreground"
                      style={{ paddingLeft: (r.depth + 1) * 14 + 12 }}
                    >
                      {fmtNum(r.unrecorded.calls)} {r.unrecorded.calls === 1 ? 'call' : 'calls'},{' '}
                      {fmtMs(r.unrecorded.ms)}, not kept
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {!recorded && (
              <p className="border-t pt-2 text-xs text-muted-foreground">
                This trace kept no spans: they are kept for failures, for requests and jobs taking{' '}
                {SLOW_TRACE_MS / 1000}s or longer, and for 1 in {Math.round(1 / TRACE_SAMPLE_RATE)} traces.
              </p>
            )}
          </div>
        </Panel>
        <Panel
          title={`${selected.op} ${selected.label}`}
          description={`at ${fmtMs(selected.start)}${selected.dur ? `, for ${fmtMs(selected.dur)}` : ''}`}
        >
          <dl className="grid grid-cols-[6.5rem_1fr] font-mono text-[12px]">
            {Object.entries(selected.event)
              .filter(([k]) => !['_p', 'app', 'stage', 'stack', 'trace'].includes(k))
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="border-b py-1.5 text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 border-b py-1.5 break-all">
                    {k === 'ts' && typeof v === 'number'
                      ? when(v)
                      : typeof v === 'string'
                        ? v
                        : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
          </dl>
          {'stack' in selected.event && typeof selected.event.stack === 'string' && (
            <pre className="mt-3 overflow-x-auto rounded-md border bg-background p-3 font-mono text-[11.5px] leading-relaxed">
              {stackFrames(selected.event.stack).map(({ key, frame, own }) => (
                <span key={key} className={cn('block', own ? 'text-foreground' : 'text-subtle')}>
                  {frame}
                </span>
              ))}
            </pre>
          )}
        </Panel>
      </div>

      {logs.length > 0 && (
        <Panel flush title="Logs in this trace">
          <ul className="font-mono text-[12px]">
            {logs.map((r) => (
              <li
                key={r.key}
                className="grid grid-cols-[6rem_3.5rem_1fr] gap-3 border-b px-4 py-1.5 last:border-0"
              >
                <span className="text-muted-foreground tabular">+{fmtMs(r.start)}</span>
                <span className={r.failed ? 'text-bad' : 'text-muted-foreground'}>
                  {r.kind === 'err' ? 'error' : r.op}
                </span>
                <span className="min-w-0 break-words">
                  {r.kind === 'err' ? `${r.op}: ${r.label}` : r.label}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
