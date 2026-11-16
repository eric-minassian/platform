/**
 * A chart in a panel, with what you can do with it: open it in the Metrics
 * explorer, add it to a dashboard, or start an alert rule from it.
 */
import { checkSeriesQuery, type MetricsView } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { BellPlus, ChartSpline, LayoutGrid, MoreHorizontal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { TimeSearch } from '../../lib/time.ts';
import { AddToDashboardDialog } from '../dashboards/add-to-dashboard.tsx';
import { Panel } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx';
import { plainQuery, MetricView } from './metric-view.tsx';

export function ChartMenu({
  app,
  stage,
  title,
  view,
}: {
  app: string;
  stage: string;
  title: string;
  view: MetricsView;
}) {
  const [adding, setAdding] = useState(false);
  const first = view.queries[0];
  const alertable =
    first && !first.app && !first.stage && !checkSeriesQuery(plainQuery(first), { alert: true });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${title}: more`} />}>
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            render={<Link to="/apps/$app/metrics" params={{ app }} search={(prev) => ({ ...prev, view })} />}
          >
            <ChartSpline />
            Open in Metrics
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setAdding(true)}>
            <LayoutGrid />
            Add to dashboard
          </DropdownMenuItem>
          {alertable && (
            <DropdownMenuItem
              render={
                <Link
                  to="/apps/$app/alerts"
                  params={{ app }}
                  search={(prev) => ({ ...prev, draft: plainQuery(first) })}
                />
              }
            >
              <BellPlus />
              Create alert
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AddToDashboardDialog
        open={adding}
        onOpenChange={setAdding}
        app={app}
        stage={stage}
        title={title}
        view={view}
      />
    </>
  );
}

export function ChartPanel({
  title,
  description,
  app,
  stage,
  time,
  view,
  height = 200,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  app: string;
  stage: string;
  time: TimeSearch;
  view: MetricsView;
  height?: number;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <Panel
      title={title}
      description={description}
      className={className}
      actions={
        <>
          {actions}
          <ChartMenu app={app} stage={stage} title={title} view={view} />
        </>
      }
    >
      <MetricView view={view} app={app} stage={stage} time={time} height={height} />
    </Panel>
  );
}
