/**
 * A dashboard widget's content: an explorer view drawn by MetricView, or the
 * newest lines of a log search. A widget for an app the member can't see
 * shows the API's refusal instead of data.
 */
import { useAtomValue } from '@effect/atom-react';
import type { DashboardWidget, LogsView } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { family } from '../../data/atoms.ts';
import { useAutoRefresh } from '../../lib/hooks.ts';
import { apiTime, timeFormat, type TimeSearch } from '../../lib/time.ts';
import { cn, keyed } from '../../lib/utils.ts';
import { streamLabel } from '../logs/log-table.tsx';
import { MetricView } from '../metrics/metric-view.tsx';
import { EmptyState, Loaded } from '../page.tsx';

const logWidgetAtom = family((k: { app: string; stage: string; time: TimeSearch; view: LogsView }) =>
  fresh(
    ApiClient.query('observe', 'logs', {
      params: { app: k.app },
      query: {
        stage: k.stage,
        ...apiTime(k.time),
        ...(k.view.q ? { q: k.view.q } : {}),
        ...(k.view.filters ? { f: k.view.filters } : {}),
        limit: 50,
      },
      timeToLive,
    }),
    { staleTime: '30 seconds' },
  ),
);

function LogsWidget({
  app,
  stage,
  time,
  view,
  utc,
}: {
  app: string;
  stage: string;
  time: TimeSearch;
  view: LogsView;
  utc: boolean;
}) {
  const atom = logWidgetAtom({ app, stage, time, view });
  useAutoRefresh(atom, time.from === undefined);
  const result = useAtomValue(atom);
  const when = timeFormat(utc, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  if (view.insights !== undefined) {
    return (
      <EmptyState title="A Logs Insights query">
        Insights queries run when opened, since each one costs a scan.{' '}
        <Link
          to="/apps/$app/logs"
          params={{ app }}
          search={(prev) => ({ ...prev, insights: view.insights })}
          className="text-info hover:underline"
        >
          Run it in Logs
        </Link>
      </EmptyState>
    );
  }
  return (
    <Loaded result={result} loading={<div className="h-full" />}>
      {({ lines }) =>
        lines.length === 0 ? (
          <EmptyState title="No lines in this window" />
        ) : (
          <ul className="font-mono text-[11.5px]">
            {keyed(lines, (l) => `${l.ts}|${l.stream}|${l.message.slice(0, 60)}`).map(({ key, item: l }) => (
              <li
                key={key}
                className={cn(
                  'grid grid-cols-[4.75rem_3.5rem_1fr] gap-2 border-l-2 border-transparent py-0.5 pl-1.5',
                  l.level === 'error' && 'border-l-bad-mark',
                  l.level === 'warn' && 'border-l-warn-mark',
                )}
              >
                <span className="text-muted-foreground tabular">{when(l.ts)}</span>
                <span className="truncate text-muted-foreground">{streamLabel(l.stream)}</span>
                <span className="truncate">{l.message}</span>
              </li>
            ))}
          </ul>
        )
      }
    </Loaded>
  );
}

export function WidgetBody({
  widget,
  app,
  stage,
  time,
  height,
  utc,
}: {
  widget: DashboardWidget;
  /** The app the widget reads when it names none. */
  app: string | undefined;
  stage: string;
  time: TimeSearch;
  height: number;
  utc: boolean;
}) {
  const target = widget.app ?? app;
  const targetStage = widget.stage ?? stage;
  if (!target) return <EmptyState title="This widget names no app">Edit it and pick one.</EmptyState>;
  if (widget.view.kind === 'logs')
    return <LogsWidget app={target} stage={targetStage} time={time} view={widget.view} utc={utc} />;
  return <MetricView view={widget.view} app={target} stage={targetStage} time={time} height={height} fit />;
}
