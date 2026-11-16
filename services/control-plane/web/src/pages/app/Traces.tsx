import { useAtomValue } from '@effect/atom-react';
import { SLOW_TRACE_MS, type TelemetryEvent, TRACE_SAMPLE_RATE } from '@ericminassian/platform-core';
import { Atom } from 'effect/reactivity';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { Badge, Button, Card, Empty, Input, Loaded, Mono, type Tone } from '../../components/ui.tsx';
import { fmtDateTime, fmtMs } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

interface Row {
  e: TelemetryEvent;
  label: string;
  /** The calls of a request or job whose spans weren't written. */
  unrecorded?: string;
  start: number;
  dur: number;
  tone: Tone;
}

const durOf = (e: TelemetryEvent): number => ('dur' in e && typeof e.dur === 'number' ? e.dur : 0);

const UNRECORDED_HINT = `Calls are recorded for requests and jobs that fail or take ${SLOW_TRACE_MS / 1_000}s or longer, and for 1 in ${Math.round(1 / TRACE_SAMPLE_RATE)} traces.`;

/** `12 calls, 34ms, not recorded`; `more calls` when the others were (a request past the cap). */
function unrecorded(e: TelemetryEvent): string | undefined {
  if ((e.t !== 'req' && e.t !== 'job') || !e.calls) return undefined;
  const calls = `${e.calls} ${e.span ? 'more ' : ''}${e.calls === 1 ? 'call' : 'calls'}`;
  return `${calls}, ${fmtMs(e.callMs ?? 0)}, not recorded`;
}

/** Lays events out on one timeline. Events log at their end, so start = ts - dur unless a start offset is given. */
export function layout(events: readonly TelemetryEvent[]): { rows: Row[]; total: number } {
  if (events.length === 0) return { rows: [], total: 0 };
  const starts = events.map((e) => e.ts - durOf(e));
  const t0 = Math.min(...starts);
  const rows = events.map((e, i): Row => {
    const dur = durOf(e);
    const start = e.t === 'span' && typeof e.start === 'number' ? e.start : starts[i]! - t0;
    const label =
      e.t === 'req'
        ? `${e.method} ${e.route} → ${e.status}`
        : e.t === 'job'
          ? `${e.kind} ${e.name} (${e.status})`
          : e.t === 'span'
            ? `${e.op}${e.name ? ` ${e.name}` : ''}`
            : e.t === 'err'
              ? `${e.name}: ${e.message}`
              : e.t === 'log'
                ? e.msg
                : e.t;
    const note = unrecorded(e);
    const failed = (e.t === 'span' || e.t === 'job') && e.status === 'error';
    const tone: Tone =
      e.t === 'err' || failed || (e.t === 'req' && e.status >= 500)
        ? 'bad'
        : e.t === 'log'
          ? 'muted'
          : 'info';
    return { e, label, ...(note ? { unrecorded: note } : {}), start, dur, tone };
  });
  const total = Math.max(1, ...rows.map((r) => r.start + r.dur));
  return { rows: rows.toSorted((a, b) => a.start - b.start), total };
}

const barColor: Record<Tone, string> = {
  bad: 'bg-bad',
  info: 'bg-accent',
  muted: 'bg-muted/60',
  ok: 'bg-ok',
  warn: 'bg-warn',
};

function Waterfall({ events }: { events: readonly TelemetryEvent[] }) {
  const { rows, total } = layout(events);
  if (rows.length === 0) return <Empty>No events found for this trace in the last 7 days.</Empty>;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between pb-1 text-[11px] text-muted">
        <span>{fmtDateTime(rows[0]!.e.ts)}</span>
        <span>total {fmtMs(total)}</span>
      </div>
      {rows.map((r, i) => (
        <div
          // oxlint-disable-next-line react/no-array-index-key -- trace rows are positional
          key={i}
          className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-3 py-0.5 text-[12px]"
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <Badge tone={r.tone}>{r.e.t}</Badge>
            <div className="min-w-0">
              <div className="truncate" title={r.label}>
                {r.label}
              </div>
              {r.unrecorded && (
                <div className="truncate text-[11px] text-muted" title={UNRECORDED_HINT}>
                  {r.unrecorded}
                </div>
              )}
            </div>
          </div>
          <div className="relative h-4 rounded bg-panel-2">
            <div
              className={`absolute top-0.5 h-3 rounded ${barColor[r.tone]}`}
              style={{
                left: `${(r.start / total) * 100}%`,
                width: r.dur ? `${Math.max((r.dur / total) * 100, 0.5)}%` : '2px',
              }}
              title={`${fmtMs(r.start)} +${fmtMs(r.dur)}`}
            />
            {r.dur > 0 && (
              <span className="absolute top-0 right-1 text-[10px] leading-4 text-muted">{fmtMs(r.dur)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// A trace's events don't change once it has finished, and each lookup runs a Logs Insights query.
const traceAtom = Atom.family(({ app, stage, trace }: { app: string; stage: string; trace: string }) =>
  fresh(ApiClient.query('observe', 'trace', { params: { app, trace }, query: { stage }, timeToLive }), {
    staleTime: '5 minutes',
  }),
);

function Trace(key: { app: string; stage: string; trace: string }) {
  return <Loaded result={useAtomValue(traceAtom(key))}>{(t) => <Waterfall events={t.events} />}</Loaded>;
}

export function TracesTab() {
  const { app, scope, search } = useApp();
  const { trace } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(trace ?? '');
  return (
    <Card
      title={
        trace ? (
          <>
            Trace <Mono>{trace}</Mono>
          </>
        ) : (
          'Traces'
        )
      }
      actions={
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) void navigate(`/apps/${app}/traces/${draft.trim()}${search}`);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="trace id"
            className="w-72"
          />
          <Button type="submit">Open</Button>
        </form>
      }
    >
      {trace ? (
        <Trace app={app} stage={scope.stage} trace={trace} />
      ) : (
        <Empty>
          Every request, job and span carries a trace id. Open one from Logs or Errors, or paste it above (
          <Mono>plat traces {app} &lt;id&gt;</Mono>).
        </Empty>
      )}
    </Card>
  );
}
