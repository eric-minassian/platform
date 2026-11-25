/**
 * One trace as a waterfall: the request or job that started it, every call
 * it made nested under its caller on one time axis, what the selected span
 * carried beside it, and the trace's log lines below.
 */
import { useAtomValue } from '@effect/atom-react';
import { SLOW_TRACE_MS, TRACE_SAMPLE_RATE, type TelemetryEvent } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import {
  createWaterfallController,
  visibleWaterfallRows,
  Waterfall,
  WaterfallAxis,
  WaterfallBar,
  WaterfallCell,
  WaterfallColumnHeader,
  WaterfallHeaderRow,
  WaterfallIndicator,
  WaterfallMark,
  WaterfallRow,
  WaterfallRowHeader,
  WaterfallTick,
} from '@ui-sdk/react/waterfall';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, ScrollText } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { stackFrames } from '../../components/logs/stack.tsx';
import {
  EmptyState,
  Fact,
  Facts,
  Loaded,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
  StatusText,
  type Tone,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { toast } from '../../components/ui/overlays.tsx';
import { Tip } from '../../components/ui/tooltip.tsx';
import { family } from '../../data/atoms.ts';
import { fmtMs, fmtNum, shortId } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { timeFormat } from '../../lib/time.ts';
import { layoutTrace, type TraceLayout, type TraceLine, type TraceSpan } from '../../lib/trace.ts';
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
    { staleTime: '10 minutes' },
  ),
);

const copyId = (trace: string) =>
  void navigator.clipboard.writeText(trace).then(
    () => toast.success('Copied the trace id'),
    () => toast.error("Couldn't copy to the clipboard"),
  );

const toneOf = (s: TraceSpan): Tone => (s.failed ? 'bad' : 'ok');

/** How a span's status reads: a request's code, else OK or Failed. */
const statusWord = (s: TraceSpan) => (s.event.t === 'req' ? s.status : s.failed ? 'Failed' : 'OK');

const LEVEL_TEXT: Record<string, string> = {
  error: 'text-bad',
  warn: 'text-warn',
  info: 'text-muted-foreground',
  debug: 'text-subtle',
};

export function TracePage() {
  const { app, trace } = traceRoute.useParams();
  const stage = useStage();
  const result = useAtomValue(traceAtom({ app, stage, trace }));
  return (
    <Loaded result={result}>
      {(t) =>
        t.events.length === 0 ? (
          <>
            <PageHeader title={<Mono className="truncate text-xl">{trace}</Mono>} />
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
  events: readonly TelemetryEvent[];
}) {
  const { utc } = usePrefs();
  const layout = useMemo(() => layoutTrace(events), [events]);
  const root = layout.root;
  const when = timeFormat(utc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  const [selected, setSelected] = useState(root?.value ?? null);
  const span = (selected ? layout.byValue.get(selected) : undefined) ?? root;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={
          root ? (
            <>
              <span className="shrink-0 font-mono text-base font-medium text-subtle">{root.op}</span>
              <span className="min-w-0 truncate font-mono text-xl">{root.name}</span>
              <StatusPill tone={toneOf(root)}>{statusWord(root)}</StatusPill>
            </>
          ) : (
            <Mono className="truncate text-xl">{trace}</Mono>
          )
        }
        description={
          <>
            Trace <Mono className="text-foreground">{trace}</Mono>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  to="/apps/$app/logs"
                  params={{ app }}
                  search={(prev) => ({ ...prev, f: { trace }, range: '7d', from: undefined, to: undefined })}
                />
              }
            >
              <ScrollText />
              Logs
            </Button>
            <Button variant="outline" size="sm" onClick={() => copyId(trace)}>
              <Copy />
              Copy id
            </Button>
          </>
        }
      />

      <dl className="grid min-w-0 grid-cols-2 overflow-hidden rounded-xl border bg-card md:grid-cols-4 [&>div]:-mt-px [&>div]:-ml-px [&>div]:border-t [&>div]:border-l">
        <HeaderFact label="Outcome">
          {root ? (
            <StatusText tone={toneOf(root)}>
              {root.event.t === 'req' ? `${root.status}${root.failed ? ' error' : ''}` : statusWord(root)}
            </StatusText>
          ) : (
            '–'
          )}
        </HeaderFact>
        <HeaderFact label="Duration">
          <span className="tabular">{fmtMs(root?.duration ?? layout.total)}</span>
        </HeaderFact>
        <HeaderFact label="Started">
          <span className="tabular">{when(layout.t0)}</span>
        </HeaderFact>
        <HeaderFact label="Deployment">
          {root ? (
            <Link
              to="/apps/$app/deployments/$deployment"
              params={{ app, deployment: root.event.rev }}
              className="rounded-sm font-mono text-[13px] hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
            >
              {shortId(root.event.rev)}
            </Link>
          ) : (
            '–'
          )}
        </HeaderFact>
      </dl>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <SpanWaterfall layout={layout} selected={span?.value ?? null} onSelect={setSelected} />
        {span && <SpanDetails layout={layout} span={span} />}
      </div>

      {layout.lines.length > 0 && <TraceLines layout={layout} />}
    </div>
  );
}

function HeaderFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-5 py-3.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

function SpanWaterfall({
  layout,
  selected,
  onSelect,
}: {
  layout: TraceLayout;
  selected: string | null;
  onSelect: (value: string) => void;
}) {
  const branches = useMemo(
    () => [...layout.byValue.values()].filter((s) => s.children).map((s) => s.value),
    [layout],
  );
  const [controller] = useState(() => createWaterfallController());
  // Traces are short enough to open whole.
  const [expanded, setExpanded] = useState(branches);
  const rows = visibleWaterfallRows(layout.spans, expanded);
  const errors = layout.lines.filter((l) => l.event.t === 'err');
  const spanCount = layout.byValue.size;
  const kept = [...layout.byValue.values()].some((s) => s.event.t === 'span');
  const unrecorded = layout.root?.unrecorded;

  return (
    <Panel
      flush
      title="Spans"
      description={`${fmtNum(spanCount)} ${spanCount === 1 ? 'span' : 'spans'} over ${fmtMs(layout.total)}`}
      actions={
        branches.length > 0 && (
          <>
            <Tip label="Expand all">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Expand all spans"
                onClick={() => controller.expandAll()}
              >
                <ChevronsUpDown />
              </Button>
            </Tip>
            <Tip label="Collapse all">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Collapse all spans"
                onClick={() => controller.collapseAll()}
              >
                <ChevronsDownUp />
              </Button>
            </Tip>
          </>
        )
      }
      footer={
        !kept ? (
          <span>
            This trace kept no spans
            {unrecorded
              ? `: ${fmtNum(unrecorded.calls)} ${unrecorded.calls === 1 ? 'call' : 'calls'} (${fmtMs(unrecorded.ms)}) weren't written`
              : ''}
            . Spans are kept for failures, for requests and jobs taking {SLOW_TRACE_MS / 1000}s or longer, and
            for 1 in {Math.round(1 / TRACE_SAMPLE_RATE)} traces.
          </span>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <Waterfall
          aria-label="Spans of this trace"
          items={layout.spans}
          range={[0, layout.total]}
          controller={controller}
          expanded={expanded}
          onExpandedChange={setExpanded}
          value={selected}
          onValueChange={(next) => next !== null && onSelect(next)}
          format={fmtMs}
          getBarLabel={(item, { start, duration }) => {
            const s = layout.byValue.get(item.value);
            return `${s ? statusWord(s) : ''}, starts at ${start}, takes ${duration}`;
          }}
          className="relative grid min-w-[40rem] grid-cols-[minmax(13rem,2fr)_4.5rem_minmax(0,3fr)] overflow-hidden text-[13px]"
        >
          <WaterfallHeaderRow className="col-span-full grid h-8 grid-cols-subgrid items-center gap-x-3 border-b px-5 text-xs text-muted-foreground">
            <WaterfallColumnHeader>Span</WaterfallColumnHeader>
            <WaterfallColumnHeader className="text-right">Duration</WaterfallColumnHeader>
            <WaterfallColumnHeader aria-label="Timeline" className="relative h-full">
              <WaterfallAxis maxTicks={6} className="absolute inset-0">
                {({ ticks }) =>
                  ticks.map((tick) => (
                    <WaterfallTick
                      key={tick.time}
                      time={tick.time}
                      className="absolute inset-y-0 start-(--waterfall-tick) flex items-center font-mono text-[11px] text-subtle tabular after:absolute after:start-0 after:top-full after:h-[200vh] after:w-px after:bg-(--chart-grid) [&:not(:first-child)]:-translate-x-1/2"
                    >
                      {tick.label}
                    </WaterfallTick>
                  ))
                }
              </WaterfallAxis>
              {errors.map((e) => (
                <WaterfallMark
                  key={e.key}
                  time={e.at}
                  aria-hidden
                  title={e.text}
                  className="pointer-events-none absolute start-(--waterfall-mark) top-1/2 h-[200vh] w-px bg-bad-mark/70 data-outside:hidden"
                />
              ))}
            </WaterfallColumnHeader>
          </WaterfallHeaderRow>
          {rows.map(({ item }) => {
            const s = layout.byValue.get(item.value)!;
            return (
              <WaterfallRow
                key={item.value}
                value={item.value}
                className="col-span-full grid h-8 cursor-default grid-cols-subgrid items-center gap-x-3 px-5 hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid data-selected:bg-accent"
              >
                <WaterfallRowHeader className="flex min-w-0 items-center gap-1.5 ps-[calc((var(--waterfall-level)_-_1)*1rem)] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid">
                  {s.children ? (
                    <WaterfallIndicator className="grid size-5 shrink-0 place-items-center rounded text-subtle hover:bg-active hover:text-foreground data-expanded:[&>svg]:rotate-90">
                      <ChevronRight
                        aria-hidden
                        className="size-3.5 transition-transform motion-reduce:transition-none"
                      />
                    </WaterfallIndicator>
                  ) : (
                    <span aria-hidden className="size-5 shrink-0" />
                  )}
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[11.5px]',
                      s.failed ? 'text-bad' : s.depth === 0 ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {s.op}
                  </span>
                  <span className="truncate">{s.name}</span>
                </WaterfallRowHeader>
                <WaterfallCell className="text-right font-mono text-[12px] text-muted-foreground tabular focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid">
                  {fmtMs(s.duration)}
                </WaterfallCell>
                <WaterfallBar
                  data-failed={s.failed || undefined}
                  className="relative h-full before:absolute before:inset-y-2 before:start-(--waterfall-start) before:w-[max(2px,var(--waterfall-size))] before:rounded-[3px] before:bg-(--chart-1) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid data-failed:before:bg-bad-mark"
                />
              </WaterfallRow>
            );
          })}
        </Waterfall>
      </div>
    </Panel>
  );
}

/** Fields every event has, or that the span's facts already show. */
const SHOWN = new Set([
  '_p',
  'app',
  'stage',
  'trace',
  'span',
  'parent',
  't',
  'ts',
  'dur',
  'start',
  'rev',
  'stack',
]);
const SHOWN_BY_KIND: Record<TraceSpan['event']['t'], readonly string[]> = {
  req: ['method', 'route', 'status', 'calls', 'callMs'],
  job: ['kind', 'name', 'status', 'calls', 'callMs'],
  span: ['op', 'name', 'status'],
};

function attributesOf(s: TraceSpan): Array<[string, string]> {
  const skip = new Set([...SHOWN, ...SHOWN_BY_KIND[s.event.t]]);
  return Object.entries(s.event)
    .filter(([k, v]) => !skip.has(k) && v !== undefined)
    .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
}

function SpanDetails({ layout, span }: { layout: TraceLayout; span: TraceSpan }) {
  const parent = span.event.parent ? layout.byValue.get(span.event.parent) : undefined;
  const attributes = attributesOf(span);
  const errors = layout.lines.filter((l) => l.span === span.value && l.event.t === 'err');
  const logs = layout.lines.filter((l) => l.span === span.value && l.event.t !== 'err').length;
  return (
    <Panel
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-medium text-subtle">{span.op}</span>
          <span className="truncate">{span.name || span.op}</span>
        </span>
      }
      description={
        span.depth === 0
          ? span.event.t === 'req'
            ? 'Request'
            : 'Job'
          : `In ${parent?.label ?? 'its caller'}`
      }
      actions={<StatusPill tone={toneOf(span)}>{statusWord(span)}</StatusPill>}
      className="xl:sticky xl:top-4"
    >
      <div className="flex flex-col gap-5">
        <Facts className="grid-cols-[6rem_1fr] gap-y-2 text-[13px]">
          <Fact label="Starts">
            <span className="tabular">+{fmtMs(span.start)}</span>
          </Fact>
          <Fact label="Duration">
            <span className="tabular">{fmtMs(span.duration)}</span>
          </Fact>
          {span.unrecorded && (
            <Fact label="Not kept">
              <span className="tabular">
                {fmtNum(span.unrecorded.calls)} {span.unrecorded.calls === 1 ? 'call' : 'calls'},{' '}
                {fmtMs(span.unrecorded.ms)}
              </span>
            </Fact>
          )}
          {logs > 0 && (
            <Fact label="Logs">
              <span className="tabular">
                {fmtNum(logs)} {logs === 1 ? 'line' : 'lines'}
              </span>
            </Fact>
          )}
          {span.event.span && (
            <Fact label="Span id">
              <Mono className="text-[12px] break-all">{span.event.span}</Mono>
            </Fact>
          )}
        </Facts>

        {attributes.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">Attributes</h3>
            <dl className="grid grid-cols-[6rem_1fr] rounded-lg border font-mono text-[12px]">
              {attributes.map(([k, v]) => (
                <div key={k} className="col-span-2 grid grid-cols-subgrid border-b px-3 py-1.5 last:border-0">
                  <dt className="truncate text-muted-foreground">{k}</dt>
                  <dd className="min-w-0 break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {errors.map((line) => (
          <ErrorDetail key={line.key} line={line} />
        ))}
      </div>
    </Panel>
  );
}

function ErrorDetail({ line }: { line: TraceLine }) {
  if (line.event.t !== 'err') return null;
  const e = line.event;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        Error at <span className="tabular">+{fmtMs(line.at)}</span>
      </h3>
      <div className="overflow-hidden rounded-lg border border-bad-mark/30">
        <p className="bg-bad-mark/8 px-3 py-2 text-[13px] break-words text-bad">
          <span className="font-medium">{e.name}</span>: {e.message}
        </p>
        {e.stack && (
          <pre className="border-t border-bad-mark/20 bg-muted px-3 py-2.5 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
            {stackFrames(e.stack)
              .slice(1)
              .map(({ key, frame, own }) => (
                <span key={key} className={cn('block', own ? 'text-foreground' : 'text-subtle')}>
                  {frame.trim()}
                </span>
              ))}
          </pre>
        )}
      </div>
    </section>
  );
}

const LOG_BASE = new Set(['_p', 't', 'ts', 'app', 'stage', 'rev', 'trace', 'span', 'parent', 'level', 'msg']);

/** A log line's own fields, after its level and message. */
function fieldsOf(line: TraceLine): string | undefined {
  if (line.event.t !== 'log') return undefined;
  const rest = Object.fromEntries(Object.entries(line.event).filter(([k]) => !LOG_BASE.has(k)));
  return Object.keys(rest).length ? JSON.stringify(rest) : undefined;
}

function TraceLines({ layout }: { layout: TraceLayout }) {
  return (
    <Panel
      flush
      title="Logs"
      description="Lines written during the trace, with the span they were written in"
    >
      <ul aria-label="Log lines in this trace" className="font-mono text-[12px]">
        {layout.lines.map((l) => {
          const fields = fieldsOf(l);
          const owner = l.span ? layout.byValue.get(l.span) : undefined;
          return (
            <li
              key={l.key}
              className="grid grid-cols-[5rem_3.5rem_minmax(0,1fr)] gap-x-3 border-b px-5 py-1.5 last:border-0 md:grid-cols-[5rem_3.5rem_minmax(0,1fr)_minmax(0,14rem)]"
            >
              <span className="text-muted-foreground tabular">+{fmtMs(l.at)}</span>
              <span className={LEVEL_TEXT[l.level] ?? 'text-muted-foreground'}>{l.level}</span>
              <span className="min-w-0 break-words">
                {l.text}
                {fields && <span className="text-subtle"> {fields}</span>}
              </span>
              <span className="hidden truncate text-right text-subtle md:block">{owner?.label}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
