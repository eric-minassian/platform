/**
 * A chart in a panel, with what you can do with it: open it in the Metrics
 * explorer, or start an alert rule from it.
 */
import { checkSeriesQuery, type MetricsView } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { BellPlus, ChartSpline, MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TimeSearch } from '../../lib/time.ts';
import { plainQuery } from '../../lib/view.ts';
import { Panel } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu.tsx';
import { MetricView } from './metric-view.tsx';

export function ChartMenu({ app, title, view }: { app: string; title: string; view: MetricsView }) {
  const first = view.queries[0];
  // An alert rule watches one series of its own stage.
  const alertable = first && !first.stage && !checkSeriesQuery(plainQuery(first), { alert: true });
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${title}`} />}>
        <MoreHorizontal />
      </MenuTrigger>
      <MenuContent align="end" className="w-48">
        <MenuItem
          render={<Link to="/apps/$app/metrics" params={{ app }} search={(prev) => ({ ...prev, view })} />}
        >
          <ChartSpline />
          Open in Metrics
        </MenuItem>
        {alertable && (
          <MenuItem
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
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
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
          <ChartMenu app={app} title={title} view={view} />
        </>
      }
    >
      <MetricView view={view} app={app} stage={stage} time={time} height={height} />
    </Panel>
  );
}
