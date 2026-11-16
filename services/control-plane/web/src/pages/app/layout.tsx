/**
 * Every app page: the app must exist and be visible to the member, and every
 * chart on the page shares one cursor, the stage's deployment markers, and
 * drag-to-zoom on the page's time window.
 */
import { useAtomValue } from '@effect/atom-react';
import type { DeploymentRecord } from '@ericminassian/platform-core';
import { Link, Outlet } from '@tanstack/react-router';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useMemo } from 'react';
import { ChartGroup, type ChartMarker } from '../../components/charts/chart-group.tsx';
import { EmptyState, ErrorNotice, Loading } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { deploymentsAtom } from '../../data/atoms.ts';
import { useAppSummary } from '../../data/hooks.ts';
import { useStage, useTime } from '../../lib/hooks.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { appRoute } from '../../router.tsx';

/** A succeeded deployment as a chart marker: when it went live, and what it was. */
export function deploymentMarker(d: DeploymentRecord): ChartMarker | undefined {
  if (d.status !== 'succeeded' && d.status !== 'rolled_back') return undefined;
  const at = Date.parse(d.finishedAt ?? d.createdAt);
  if (!Number.isFinite(at)) return undefined;
  const label = d.commit ? d.commit.slice(0, 7) : d.id.slice(-7);
  const what = d.computeSwitchOf
    ? `Switched to ${d.compute === 'request' ? 'request' : 'instance'} mode`
    : `Deployed ${label}${d.message ? ` · ${d.message.split('\n')[0]}` : ''}`;
  return { ts: at, label, detail: what };
}

export function AppLayout() {
  const { app } = appRoute.useParams();
  const result = useAppSummary(app);
  return AsyncResult.match(result, {
    onInitial: () => <Loading className="h-64" />,
    onFailure: ({ cause }) => (
      <EmptyState
        title={`Can't open ${app}`}
        action={
          <Button variant="outline" nativeButton={false} render={<Link to="/" />}>
            All apps
          </Button>
        }
      >
        <ErrorNotice error={cause} className="mt-2 text-left" />
      </EmptyState>
    ),
    onSuccess: () => <AppCharts app={app} />,
  });
}

function AppCharts({ app }: { app: string }) {
  const stage = useStage();
  const time = useTime();
  const { utc } = usePrefs();
  const deployments = Option.getOrElse(
    AsyncResult.value(useAtomValue(deploymentsAtom({ app, stage }))),
    () => [],
  );
  const markers = useMemo(
    () => deployments.flatMap((d) => deploymentMarker(d) ?? []).toSorted((a, b) => a.ts - b.ts),
    [deployments],
  );
  return (
    <ChartGroup markers={markers} utc={utc} onZoom={time.zoom}>
      <Outlet />
    </ChartGroup>
  );
}
