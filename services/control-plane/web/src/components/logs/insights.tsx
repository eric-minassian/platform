/**
 * Logs Insights for when filters aren't enough: write a query, run it on
 * the stage's log groups over the page's window, and read the result as a
 * table, or as a chart when it is a `stats … by bin(…)`.
 */
import { useAtomSet } from '@effect/atom-react';
import type { InsightsResponse } from '@ericminassian/platform-core';
import { shortcuts, useShortcut, useShortcutHint } from '@ui-sdk/react/shortcuts';
import { Exit } from 'effect';
import { Play, SquareTerminal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ApiClient, errorMessage } from '../../client.ts';
import { fmtBytes, fmtNum } from '../../format.ts';
import { chartOf } from '../../lib/insights.ts';
import type { TimeSearch } from '../../lib/time.ts';
import { apiTime } from '../../lib/time.ts';
import { keyed } from '../../lib/utils.ts';
import { TimeChart } from '../charts/time-chart.tsx';
import { columns, DataTable } from '../data-table.tsx';
import { EmptyState, ErrorNotice, Panel } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { Textarea } from '../ui/textarea.tsx';

export const SAMPLE_QUERY = `fields @timestamp, @message
| filter level = "error"
| sort @timestamp desc
| limit 100`;

const runInsights = ApiClient.mutation('observe', 'insights');

interface ResultRow {
  readonly key: string;
  readonly cells: ReadonlyArray<string | null>;
}

const col = columns<ResultRow>();

function Results({ result }: { result: InsightsResponse }) {
  const chart = useMemo(() => chartOf(result), [result]);
  const rows = useMemo(
    () => keyed(result.rows, (row) => row.join('\u0000')).map(({ key, item }) => ({ key, cells: item })),
    [result],
  );
  const defs = useMemo(
    () =>
      col.columns(
        result.columns.map((name, i) =>
          col.accessor((r) => r.cells[i] ?? '', {
            id: `${i}:${name}`,
            header: name,
            meta: { className: 'max-w-[48rem] align-top font-mono text-[12px] break-words' },
          }),
        ),
      ),
    [result],
  );
  return (
    <Panel
      flush
      title="Results"
      description={`${fmtNum(result.recordsMatched)} matched of ${fmtNum(result.recordsScanned)} scanned · ${fmtBytes(result.bytesScanned)}`}
      actions={
        chart && chart.series.length > 1 ? (
          <ul aria-label="Series" className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {chart.series.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {chart && (
        <div className="px-5 pb-4">
          <TimeChart
            timestamps={chart.timestamps}
            stepMs={chart.stepMs}
            series={chart.series}
            kind="bar"
            format={fmtNum}
            height={200}
            ariaLabel="Query result over time"
          />
        </div>
      )}
      <DataTable
        columns={defs}
        data={rows}
        getRowId={(r) => r.key}
        dense
        className="border-t"
        empty={<EmptyState title="No rows">The query matched nothing in this window.</EmptyState>}
      />
    </Panel>
  );
}

export function Insights({
  app,
  stage,
  time,
  query,
  onQueryChange,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const [draft, setDraft] = useState(query);
  const [result, setResult] = useState<InsightsResponse>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const run = useAtomSet(runInsights, { mode: 'promiseExit' });
  const hint = useShortcutHint('mod+enter');

  const execute = async () => {
    if (running || !draft.trim()) return;
    onQueryChange(draft);
    setRunning(true);
    setError(undefined);
    const exit = await run({ params: { app }, payload: { stage, query: draft, ...apiTime(time) } });
    setRunning(false);
    if (Exit.isFailure(exit)) setError(errorMessage(exit.cause));
    else setResult(exit.value);
  };
  useShortcut('mod+enter', () => void execute(), {
    scope: 'insights-query',
    allowInInput: true,
    description: 'Run the query',
  });
  useEffect(() => () => shortcuts.setScope('insights-query', false), []);

  return (
    <>
      <Panel
        bodyClassName="p-0"
        className="has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-3 has-[textarea:focus-visible]:ring-ring/20"
        footer={
          <>
            <Button
              size="sm"
              disabled={running || !draft.trim()}
              aria-keyshortcuts={hint.ariaKeyshortcuts}
              onClick={() => void execute()}
            >
              {running ? <Spinner className="text-primary-foreground" /> : <Play />}
              Run query
            </Button>
            <span>
              <Kbd>{hint.text}</Kbd> runs it over the page's time window, on {stage}'s log groups.
            </span>
          </>
        }
      >
        <Textarea
          aria-label="Logs Insights query"
          value={draft}
          onValueChange={setDraft}
          onFocus={() => shortcuts.setScope('insights-query', true)}
          onBlur={() => shortcuts.setScope('insights-query', false)}
          spellCheck={false}
          rows={Math.min(14, Math.max(5, draft.split('\n').length + 1))}
          className="resize-y rounded-t-xl rounded-b-none border-0 bg-transparent px-5 py-4 font-mono text-[13px] leading-relaxed hover:border-0 focus-visible:ring-0"
        />
      </Panel>
      {error && <ErrorNotice error={error} />}
      {result ? (
        <Results result={result} />
      ) : (
        !error && (
          <Panel>
            <EmptyState icon={<SquareTerminal />} title="Run a query to see its results">
              Logs Insights reads the raw lines, so it can filter, parse and aggregate anything. It costs
              $0.005 per GB it scans.
            </EmptyState>
          </Panel>
        )
      )}
    </>
  );
}
