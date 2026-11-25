/**
 * An app stage's logs. Search text, pick facets, read the volume by level
 * (drag across it to zoom), open a line beside the list for every field it
 * carries; or tail live, or switch to Logs Insights for anything filters
 * can't express.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { LogFilters, LogLine } from '@ericminassian/platform-core';
import { QUERY_RESOLUTION_MS } from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { createListboxController } from '@ui-sdk/react/listbox';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Pause, Play, Radio, Search, SearchX, X } from 'lucide-react';
import { type ReactNode, type RefObject, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, apiUrl, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { TimeChart } from '../../components/charts/time-chart.tsx';
import { Facets } from '../../components/logs/facets.tsx';
import { Insights, SAMPLE_QUERY } from '../../components/logs/insights.tsx';
import { useLiveTail } from '../../components/logs/live-tail.ts';
import { LogDetail } from '../../components/logs/log-detail.tsx';
import { LEVEL_COLORS, LogTable, lineKeys } from '../../components/logs/log-table.tsx';
import { EmptyState, ErrorNotice, PageHeader } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input.tsx';
import { Kbd } from '../../components/ui/kbd.tsx';
import { Segmented } from '../../components/ui/segmented.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { logsRoute } from '../../router.tsx';

interface LogsKey {
  readonly app: string;
  readonly stage: string;
  readonly time: TimeSearch;
  readonly q: string | undefined;
  readonly f: LogFilters | undefined;
}

const hasFilters = (f: LogFilters | undefined) =>
  !!f && Object.values(f).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));

/**
 * A CloudWatch filter pattern (`{ $.status >= 500 }`, `?a ?b`) rather than
 * text. Only the line search reads one: facets, volume and structured
 * filters run on Logs Insights, which can't.
 */
const isPattern = (q: string | undefined) => /^\s*[{?]/.test(q ?? '');

const PATTERN_NOTE = 'Counts need plain text: a filter pattern only lists the lines it matches.';

const statsAtom = family((k: LogsKey) =>
  fresh(
    ApiClient.query('observe', 'logStats', {
      params: { app: k.app },
      query: {
        stage: k.stage,
        ...apiTime(k.time),
        ...(k.q ? { q: k.q } : {}),
        ...(hasFilters(k.f) ? { f: k.f } : {}),
      },
      timeToLive,
    }),
    { staleTime: '30 seconds' },
  ),
);

const linesAtom = family((k: LogsKey) =>
  pages(
    (next) =>
      ApiClient.use((client) =>
        client.observe.logs({
          params: { app: k.app },
          query: {
            stage: k.stage,
            ...apiTime(k.time),
            ...(k.q ? { q: k.q } : {}),
            ...(hasFilters(k.f) ? { f: k.f } : {}),
            limit: 200,
            ...(next ? { next } : {}),
          },
        }),
      ),
    (page) => page.nextToken,
  ),
);

const LEVELS = ['error', 'warn', 'info', 'debug', 'system'] as const;

type Mode = 'search' | 'live' | 'insights';

export function LogsPage() {
  const { app } = logsRoute.useParams();
  const search = logsRoute.useSearch();
  const navigate = useNavigate({ from: logsRoute.fullPath });
  const stage = useStage();
  const time = useTime();
  const { utc } = usePrefs();
  const filters = search.f ?? {};
  const mode: Mode = search.insights !== undefined ? 'insights' : search.live ? 'live' : 'search';

  const setSearch = (patch: Record<string, unknown>, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const setFilters = (f: LogFilters) => setSearch({ f: hasFilters(f) ? f : undefined });

  const scope = { app, stage, q: search.q, filters, utc };
  return (
    <>
      <PageHeader
        title="Logs"
        actions={
          <Segmented<Mode>
            label="Mode"
            value={mode}
            onChange={(m) =>
              setSearch({
                insights: m === 'insights' ? (search.insights ?? SAMPLE_QUERY) : undefined,
                live: m === 'live' ? true : undefined,
              })
            }
            options={[
              { value: 'search', label: 'Search' },
              { value: 'live', label: 'Live' },
              { value: 'insights', label: 'Insights' },
            ]}
          />
        }
      />
      {mode === 'insights' ? (
        <Insights
          app={app}
          stage={stage}
          time={time.search}
          query={search.insights ?? SAMPLE_QUERY}
          onQueryChange={(insights) => setSearch({ insights }, true)}
        />
      ) : (
        <>
          <SearchBox key={search.q ?? ''} q={search.q} onSearch={(q) => setSearch({ q })} />
          {/* Fills the panel to its bottom edge (the shell's padding is for pages that scroll). A 0px
              basis keeps the lines from sizing the page: they scroll inside instead. */}
          <div className="flex min-h-[30rem] grow basis-0 gap-6">
            <aside
              aria-label="Filters"
              className="relative hidden w-52 shrink-0 overflow-y-auto pb-4 lg:block"
            >
              {isPattern(search.q) ? (
                <Facets
                  stats={undefined}
                  filters={filters}
                  onChange={setFilters}
                  note="No counts for a filter pattern."
                />
              ) : (
                <CountedFacets {...scope} time={time.search} onChange={setFilters} />
              )}
            </aside>
            {mode === 'live' ? (
              <LiveView {...scope} onFilter={(patch) => setFilters({ ...filters, ...patch })} />
            ) : (
              <SearchView
                {...scope}
                time={time.search}
                withDate={time.window.to - time.window.from > 86_400_000}
                onFilter={(patch) => setFilters({ ...filters, ...patch })}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

function SearchBox({ q, onSearch }: { q: string | undefined; onSearch: (q: string | undefined) => void }) {
  const [draft, setDraft] = useState(q ?? '');
  const input = useRef<HTMLInputElement>(null);
  // `/` focuses the search box, as in most log viewers.
  useShortcut('/', () => input.current?.focus(), { description: 'Search log lines' });
  return (
    <search>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(draft.trim() || undefined);
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            aria-label="Search log lines"
            aria-keyshortcuts="/"
            placeholder="Search text or a filter pattern, e.g. { $.status >= 500 }"
            value={draft}
            onValueChange={setDraft}
            className="font-mono text-[13px]"
          />
          {q ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear the search"
              onClick={() => {
                setDraft('');
                onSearch(undefined);
              }}
            >
              <X />
            </Button>
          ) : (
            !draft && <Kbd aria-hidden>/</Kbd>
          )}
        </InputGroup>
      </form>
    </search>
  );
}

type Scope = {
  app: string;
  stage: string;
  q: string | undefined;
  filters: LogFilters;
  utc: boolean;
};

type StatsProps = Scope & { time: TimeSearch };

function CountedFacets({
  app,
  stage,
  time,
  q,
  filters,
  onChange,
}: StatsProps & { onChange: (f: LogFilters) => void }) {
  const stats = Option.getOrUndefined(
    AsyncResult.value(useSticky(useAtomValue(statsAtom({ app, stage, time, q, f: filters })))),
  );
  return <Facets stats={stats} filters={filters} onChange={onChange} />;
}

/** Whether the list has room for the line panel beside it; otherwise the panel is a drawer. */
function useRoomBeside(card: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= 832);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [card]);
  return wide;
}

/** The list in its card, with whatever sits above it, and the open line beside it. */
function Workspace({
  app,
  stage,
  utc,
  q,
  lines,
  top,
  onFilter,
  hasMore,
  loadingMore,
  onLoadMore,
  withDate,
  empty,
}: Scope & {
  lines: readonly LogLine[];
  top: ReactNode;
  onFilter: (patch: Partial<LogFilters>) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  withDate: boolean;
  empty: ReactNode;
}) {
  const [selected, setSelected] = useState<{ key: string; line: LogLine }>();
  const [controller] = useState(() => createListboxController());
  const card = useRef<HTMLElement>(null);
  const beside = useRoomBeside(card);
  const keys = useMemo(() => lineKeys(lines), [lines]);
  const index = selected ? keys.indexOf(selected.key) : -1;
  const step = (delta: -1 | 1) => {
    const line = index < 0 ? undefined : lines[index + delta];
    if (line) setSelected({ key: keys[index + delta]!, line });
  };
  return (
    <section ref={card} className="flex min-w-0 flex-1 overflow-hidden rounded-xl border bg-card">
      <div className="flex min-w-0 flex-1 flex-col">
        {top}
        <LogTable
          lines={lines}
          keys={keys}
          q={q}
          utc={utc}
          selected={selected?.key}
          following={selected !== undefined}
          onSelect={(line, key) => setSelected({ line, key })}
          controller={controller}
          {...(hasMore !== undefined ? { hasMore } : {})}
          {...(loadingMore !== undefined ? { loadingMore } : {})}
          {...(onLoadMore ? { onLoadMore } : {})}
          withDate={withDate}
          className="min-h-0 flex-1"
          empty={empty}
        />
      </div>
      {selected && (
        <LogDetail
          app={app}
          stage={stage}
          line={selected.line}
          utc={utc}
          inline={beside}
          onStep={step}
          onFilter={onFilter}
          onClose={(refocus) => {
            setSelected(undefined);
            // Once the panel (or the drawer that made the page inert) is gone.
            if (refocus)
              requestAnimationFrame(() => {
                controller.highlight(selected.key);
                controller.focus();
              });
          }}
        />
      )}
    </section>
  );
}

function SearchView(
  props: StatsProps & { withDate: boolean; onFilter: (patch: Partial<LogFilters>) => void },
) {
  const { app, stage, time, q, filters } = props;
  const atom = linesAtom({ app, stage, time, q, f: filters });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const loaded = loadedPages(result);
  const lines = useMemo(() => loaded.flatMap((p) => p.lines), [loaded]);
  return (
    <Workspace
      {...props}
      lines={lines}
      top={
        isPattern(q) ? (
          <p className="border-b px-5 py-3 text-xs text-muted-foreground">{PATTERN_NOTE}</p>
        ) : (
          <Volume {...props} />
        )
      }
      hasMore={loaded.at(-1)?.nextToken !== undefined}
      loadingMore={result.waiting}
      onLoadMore={() => loadMore()}
      empty={
        result._tag === 'Failure' ? (
          <ErrorNotice error={result.cause} className="m-5" />
        ) : AsyncResult.isInitial(result) || result.waiting ? (
          <EmptyState title="Reading logs…" />
        ) : (
          <EmptyState icon={<SearchX />} title="No lines match">
            Widen the time range or remove a filter.
          </EmptyState>
        )
      }
    />
  );
}

function Volume({ app, stage, time, q, filters }: StatsProps) {
  const atom = statsAtom({ app, stage, time, q, f: filters });
  useAutoRefresh(atom, time.from === undefined);
  const result = useSticky(useAtomValue(atom));
  const stats = Option.getOrUndefined(AsyncResult.value(result));
  const series = useMemo(
    () =>
      stats
        ? LEVELS.filter((l) => stats.levels[l].some((n) => n > 0)).map((l) => ({
            key: l,
            label: l,
            color: LEVEL_COLORS[l]!,
            values: stats.levels[l],
          }))
        : [],
    [stats],
  );
  const timestamps = useMemo(() => stats?.timestamps.map((t) => Date.parse(t)) ?? [], [stats]);
  return (
    <div className="shrink-0 border-b px-5 pt-3.5 pb-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-[13px] text-muted-foreground">
          <span className="font-semibold text-foreground tabular">{stats ? fmtNum(stats.total) : '–'}</span>{' '}
          lines
        </p>
        <ul className="ml-auto flex gap-3 text-xs text-muted-foreground" aria-label="Levels">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="mt-2" />}
      <TimeChart
        timestamps={timestamps}
        stepMs={stats ? QUERY_RESOLUTION_MS[stats.res] : 60_000}
        series={series}
        kind="bar"
        format={fmtNum}
        height={104}
        ariaLabel="Log lines over time by level"
      />
    </div>
  );
}

function LiveView(props: Scope & { onFilter: (patch: Partial<LogFilters>) => void }) {
  const { app, stage, q, filters } = props;
  const [paused, setPaused] = useState(false);
  const url = apiUrl.observe.tail({
    params: { app },
    query: { stage, ...(q ? { q } : {}), ...(hasFilters(filters) ? { f: filters } : {}) },
  });
  const tail = useLiveTail(url, paused);
  return (
    <Workspace
      {...props}
      lines={tail.lines}
      withDate={false}
      top={
        <>
          <div className="flex h-11 shrink-0 items-center gap-3 border-b px-5 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn('size-2 rounded-full', paused ? 'bg-subtle' : 'animate-pulse bg-ok-mark')}
              />
              {paused
                ? `Paused · ${fmtNum(tail.waiting - tail.lines.length)} new lines waiting`
                : 'Streaming new lines as they arrive'}
            </span>
            <Button variant="outline" size="xs" className="ml-auto" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play /> : <Pause />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
          {tail.error && <ErrorNotice error={tail.error} className="m-4" />}
        </>
      }
      empty={
        <EmptyState icon={<Radio />} title="Waiting for log lines…">
          A tail runs for up to 15 minutes.
        </EmptyState>
      }
    />
  );
}
