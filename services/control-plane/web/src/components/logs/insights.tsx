/**
 * Logs Insights for when filters aren't enough: write a query, run it on
 * the stage's log groups over the page's window, and read the result as a
 * table, or as a chart when it is a `stats … by bin(…)`.
 */
import { useAtomSet } from '@effect/atom-react';
import type { InsightsResponse } from '@ericminassian/platform-core';
import { Exit } from 'effect';
import { Play } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiClient, errorMessage } from '../../client.ts';
import { fmtBytes, fmtNum } from '../../format.ts';
import { chartOf } from '../../lib/insights.ts';
import type { TimeSearch } from '../../lib/time.ts';
import { apiTime } from '../../lib/time.ts';
import { keyed } from '../../lib/utils.ts';
import { TimeChart } from '../charts/time-chart.tsx';
import { EmptyState, ErrorNotice } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { Textarea } from '../ui/textarea.tsx';

export const SAMPLE_QUERY = `fields @timestamp, @message
| filter level = "error"
| sort @timestamp desc
| limit 100`;

const runInsights = ApiClient.mutation('observe', 'insights');

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
  const chart = useMemo(() => (result ? chartOf(result) : undefined), [result]);

  const execute = async () => {
    onQueryChange(draft);
    setRunning(true);
    setError(undefined);
    const exit = await run({ params: { app }, payload: { stage, query: draft, ...apiTime(time) } });
    setRunning(false);
    if (Exit.isFailure(exit)) setError(errorMessage(exit.cause));
    else setResult(exit.value);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-4">
        <Textarea
          aria-label="Logs Insights query"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void execute();
            }
          }}
          spellCheck={false}
          rows={Math.min(10, Math.max(4, draft.split('\n').length))}
          className="font-mono text-[12.5px] leading-relaxed"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={running || !draft.trim()} onClick={() => void execute()}>
            {running ? <Spinner /> : <Play />}
            Run query
          </Button>
          <span className="text-xs text-muted-foreground">
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> runs it over the page's time window, on {stage}'s log groups.
          </span>
          {result && (
            <span className="ml-auto text-xs text-muted-foreground tabular">
              {fmtNum(result.recordsMatched)} matched of {fmtNum(result.recordsScanned)} scanned ·{' '}
              {fmtBytes(result.bytesScanned)}
            </span>
          )}
        </div>
      </div>
      {error && <ErrorNotice error={error} className="m-4" />}
      {!result && !error && (
        <EmptyState title="Run a query to see its results">
          Logs Insights reads the raw lines, so it can filter, parse and aggregate anything. It costs $0.005
          per GB it scans.
        </EmptyState>
      )}
      {result && (
        <div className="min-h-0 flex-1 overflow-auto">
          {chart && (
            <div className="border-b p-4">
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
          {result.rows.length === 0 ? (
            <EmptyState title="No rows" />
          ) : (
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                <tr className="border-b">
                  {result.columns.map((c) => (
                    <th key={c} className="px-4 py-2 text-left font-medium whitespace-nowrap">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="font-mono">
                {keyed(result.rows, (row) => row.join('\u0000')).map(({ key, item: row }) => {
                  return (
                    <tr key={key} className="border-b last:border-0 hover:bg-accent/40">
                      {row.map((cell, i) => (
                        <td
                          key={result.columns[i]}
                          className="max-w-[48rem] px-4 py-1.5 align-top break-words"
                        >
                          {cell ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
