/**
 * An app stage's logs. Search text, pick facets, read the volume by level
 * (drag across it to zoom), open a line for every field it carries; or tail
 * live, or switch to Logs Insights for anything filters can't express.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { LogFilters, LogLine, LogsView, SavedQuery } from '@ericminassian/platform-core';
import { QUERY_RESOLUTION_MS } from '@ericminassian/platform-core';
import { useNavigate } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { LayoutGrid, Pause, Play, Radio, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, apiUrl, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { TimeChart } from '../../components/charts/time-chart.tsx';
import { AddToDashboardDialog } from '../../components/dashboards/add-to-dashboard.tsx';
import { Facets } from '../../components/logs/facets.tsx';
import { Insights, SAMPLE_QUERY } from '../../components/logs/insights.tsx';
import { useLiveTail } from '../../components/logs/live-tail.ts';
import { LogDrawer } from '../../components/logs/log-drawer.tsx';
import { LEVEL_COLORS, LogTable } from '../../components/logs/log-table.tsx';
import { EmptyState, ErrorNotice } from '../../components/page.tsx';
import { SavedViews } from '../../components/saved-views.tsx';
import { Segmented } from '../../components/segmented.tsx';
import { Button } from '../../components/ui/button.tsx';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input-group.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum } from '../../format.ts';
import { useAutoRefresh, useStage, useSticky, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { apiTime, type TimeSearch } from '../../lib/time.ts';
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

export function LogsPage() {
  const { app } = logsRoute.useParams();
  const search = logsRoute.useSearch();
  const navigate = useNavigate({ from: logsRoute.fullPath });
  const stage = useStage();
  const time = useTime();
  const { utc } = usePrefs();
  const filters = search.f ?? {};
  const mode = search.insights !== undefined ? 'insights' : search.live ? 'live' : 'search';
  const [draft, setDraft] = useState(search.q ?? '');
  const [selected, setSelected] = useState<{ key: string; line: LogLine }>();
  const [adding, setAdding] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  // `/` focuses the search box, as in most log viewers.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === '/' && !target?.closest('input, textarea, [contenteditable]')) {
        e.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const setSearch = (patch: Record<string, unknown>, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace });
  const setFilters = (f: LogFilters) => setSearch({ f: hasFilters(f) ? f : undefined, saved: undefined });

  const view: LogsView = {
    kind: 'logs',
    ...(search.q ? { q: search.q } : {}),
    ...(hasFilters(filters) ? { filters } : {}),
    ...(search.insights !== undefined ? { insights: search.insights } : {}),
  };
  const open = (q: SavedQuery) => {
    if (q.view.kind !== 'logs') return;
    setDraft(q.view.q ?? '');
    setSearch({
      q: q.view.q,
      f: q.view.filters,
      insights: q.view.insights,
      live: undefined,
      saved: q.id,
      ...(q.range ? { range: q.range, from: undefined, to: undefined } : {}),
    });
  };

  return (
    <div className="flex h-[calc(100svh-6.5rem)] min-h-[32rem] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {mode !== 'insights' && (
          <form
            className="min-w-64 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch({ q: draft.trim() || undefined, saved: undefined });
            }}
          >
            <InputGroup className="h-8">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchBox}
                aria-label="Search log lines"
                placeholder="Search text or a filter pattern, e.g. { $.status >= 500 }"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="font-mono text-[12.5px]"
              />
              {search.q && (
                <InputGroupAddon align="inline-end">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Clear the search"
                    onClick={() => {
                      setDraft('');
                      setSearch({ q: undefined });
                    }}
                  >
                    <X />
                  </Button>
                </InputGroupAddon>
              )}
            </InputGroup>
          </form>
        )}
        {mode === 'insights' && <div className="flex-1" />}
        <Segmented
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
            {
              value: 'live',
              label: (
                <>
                  <Radio className="size-3.5" /> Live
                </>
              ),
            },
            { value: 'insights', label: 'Insights' },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <LayoutGrid />
          Add to dashboard
        </Button>
        <SavedViews
          app={app}
          stage={stage}
          kind="logs"
          view={view}
          range={time.search.from === undefined ? (time.search.range ?? '24h') : undefined}
          currentId={search.saved}
          onOpen={open}
          onSaved={(q) => setSearch({ saved: q.id }, true)}
        />
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
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
            <aside className="hidden w-52 shrink-0 overflow-y-auto border-r lg:block" aria-label="Filters">
              <FacetsPanel
                app={app}
                stage={stage}
                time={time.search}
                q={search.q}
                filters={filters}
                onChange={setFilters}
              />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              {mode === 'live' ? (
                <Live
                  app={app}
                  stage={stage}
                  q={search.q}
                  filters={filters}
                  utc={utc}
                  selected={selected?.key}
                  onSelect={(line, key) => setSelected({ line, key })}
                />
              ) : (
                <>
                  <Volume app={app} stage={stage} time={time.search} q={search.q} filters={filters} />
                  <History
                    withDate={time.window.to - time.window.from > 86_400_000}
                    app={app}
                    stage={stage}
                    time={time.search}
                    q={search.q}
                    filters={filters}
                    utc={utc}
                    selected={selected?.key}
                    onSelect={(line, key) => setSelected({ line, key })}
                  />
                </>
              )}
            </div>
            {selected && (
              <LogDrawer
                app={app}
                stage={stage}
                line={selected.line}
                utc={utc}
                onClose={() => setSelected(undefined)}
                onFilter={(patch) => setFilters({ ...filters, ...patch })}
              />
            )}
          </>
        )}
      </div>
      <AddToDashboardDialog
        open={adding}
        onOpenChange={setAdding}
        app={app}
        stage={stage}
        title={search.insights !== undefined ? 'Logs Insights' : search.q ? `Logs: ${search.q}` : 'Logs'}
        view={view}
      />
    </div>
  );
}

function FacetsPanel({
  app,
  stage,
  time,
  q,
  filters,
  onChange,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  q: string | undefined;
  filters: LogFilters;
  onChange: (f: LogFilters) => void;
}) {
  const stats = Option.getOrUndefined(
    AsyncResult.value(useSticky(useAtomValue(statsAtom({ app, stage, time, q, f: filters })))),
  );
  return <Facets stats={stats} filters={filters} onChange={onChange} />;
}

function Volume({
  app,
  stage,
  time,
  q,
  filters,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  q: string | undefined;
  filters: LogFilters;
}) {
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
    <div className="border-b px-4 pt-3 pb-1">
      <div className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          <span className="text-sm font-medium text-foreground tabular">
            {stats ? fmtNum(stats.total) : '–'}
          </span>{' '}
          lines
        </span>
        {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="py-1" />}
        <ul className="ml-auto flex gap-3">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>
      <TimeChart
        timestamps={timestamps}
        stepMs={stats ? QUERY_RESOLUTION_MS[stats.res] : 60_000}
        series={series}
        kind="bar"
        format={fmtNum}
        height={110}
        ariaLabel="Log lines over time by level"
      />
    </div>
  );
}

function History({
  withDate,
  app,
  stage,
  time,
  q,
  filters,
  utc,
  selected,
  onSelect,
}: {
  withDate: boolean;
  app: string;
  stage: string;
  time: TimeSearch;
  q: string | undefined;
  filters: LogFilters;
  utc: boolean;
  selected: string | undefined;
  onSelect: (line: LogLine, key: string) => void;
}) {
  const atom = linesAtom({ app, stage, time, q, f: filters });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const loaded = loadedPages(result);
  const lines = useMemo(() => loaded.flatMap((p) => p.lines), [loaded]);
  const hasMore = loaded.at(-1)?.nextToken !== undefined;
  if (result._tag === 'Failure' && lines.length === 0)
    return <ErrorNotice error={result.cause} className="m-4" />;
  return (
    <LogTable
      lines={lines}
      q={q}
      utc={utc}
      selected={selected}
      onSelect={onSelect}
      hasMore={hasMore}
      loadingMore={result.waiting}
      onLoadMore={() => loadMore()}
      withDate={withDate}
      className="min-h-0 flex-1"
      empty={
        AsyncResult.isInitial(result) || result.waiting ? (
          <EmptyState title="Reading logs…" />
        ) : (
          <EmptyState title="No lines match">Widen the time range or remove a filter.</EmptyState>
        )
      }
    />
  );
}

function Live({
  app,
  stage,
  q,
  filters,
  utc,
  selected,
  onSelect,
}: {
  app: string;
  stage: string;
  q: string | undefined;
  filters: LogFilters;
  utc: boolean;
  selected: string | undefined;
  onSelect: (line: LogLine, key: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const url = apiUrl.observe.tail({
    params: { app },
    query: { stage, ...(q ? { q } : {}), ...(hasFilters(filters) ? { f: filters } : {}) },
  });
  const tail = useLiveTail(url, paused);
  return (
    <>
      <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <span
            className={
              paused ? 'size-2 rounded-full bg-subtle' : 'size-2 animate-pulse rounded-full bg-ok-mark'
            }
            aria-hidden
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
      <LogTable
        lines={tail.lines}
        withDate={false}
        q={q}
        utc={utc}
        selected={selected}
        onSelect={onSelect}
        className="min-h-0 flex-1"
        empty={<EmptyState title="Waiting for log lines…">A tail runs for up to 15 minutes.</EmptyState>}
      />
    </>
  );
}
