/**
 * The console's routes. Page state lives in the URL (time, stage, filters,
 * queries), validated per route; `retainSearchParams` keeps the time window
 * and the stage on every link, so moving between pages keeps what you're
 * looking at. Pages load on demand.
 */
import { LogFilters, MetricsView, SeriesQuery, TraceFilters } from '@ericminassian/platform-core';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  retainSearchParams,
} from '@tanstack/react-router';
import { Schema } from 'effect';
import { Shell } from './components/shell/shell.tsx';
import { searchSchema } from './lib/search.ts';
import { type TimeSearch, validateTimeSearch } from './lib/time.ts';
import { NotFoundPage } from './pages/not-found.tsx';

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** The page reads the time window: the top bar shows the time picker. */
    readonly time?: boolean;
    /** Its name in the top bar's breadcrumb. */
    readonly title?: string;
  }
}

// A page declares its component's return type: inferred, it would make the router's type depend on
// the page, whose route hooks read the router's type, and type-aware lint would see them as `any`.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazyRouteComponent(load, name);

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // `denied`: the GitHub login the server turned away (not a member); a number when it's all digits.
  validateSearch: searchSchema({
    redirect: Schema.String,
    denied: Schema.Union([Schema.String, Schema.Finite]),
  }),
  component: page(() => import('./pages/login.tsx'), 'LoginPage'),
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: Shell,
  validateSearch: validateTimeSearch,
  search: { middlewares: [retainSearchParams(['range', 'from', 'to'])] },
});

const appsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  staticData: { title: 'Apps' },
  component: page(() => import('./pages/apps.tsx'), 'AppsPage'),
});

const dashboardSearch = searchSchema({ edit: Schema.Boolean });

const dashboardsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dashboards',
  staticData: { title: 'Dashboards' },
  component: page(() => import('./pages/dashboards/list.tsx'), 'DashboardsPage'),
});

export const dashboardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dashboards/$id',
  staticData: { time: true, title: 'Dashboard' },
  validateSearch: dashboardSearch,
  component: page(() => import('./pages/dashboards/board.tsx'), 'DashboardPage'),
});

const platformRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/platform',
  staticData: { title: 'Platform' },
  component: page(() => import('./pages/platform.tsx'), 'PlatformPage'),
});

export const appRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/apps/$app',
  validateSearch: searchSchema({ stage: Schema.String }),
  search: { middlewares: [retainSearchParams<TimeSearch & { stage?: string | undefined }>(['stage'])] },
  component: page(() => import('./pages/app/layout.tsx'), 'AppLayout'),
});

const child = <P extends string>(
  path: P,
  title: string,
  component: ReturnType<typeof page>,
  options: { time?: boolean } = {},
) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    staticData: { title, ...(options.time ? { time: true } : {}) },
    component,
  });

export const overviewRoute = child(
  '/',
  'Overview',
  page(() => import('./pages/app/overview.tsx'), 'OverviewPage'),
  {
    time: true,
  },
);

export const logsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'logs',
  staticData: { title: 'Logs', time: true },
  validateSearch: searchSchema({
    q: Schema.String,
    f: LogFilters,
    insights: Schema.String,
    live: Schema.Boolean,
    saved: Schema.String,
  }),
  component: page(() => import('./pages/app/logs.tsx'), 'LogsPage'),
});

export const tracesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'traces',
  staticData: { title: 'Traces', time: true },
  validateSearch: searchSchema({ f: TraceFilters, saved: Schema.String }),
  component: page(() => import('./pages/app/traces.tsx'), 'TracesPage'),
});

export const traceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'traces/$trace',
  staticData: { title: 'Trace' },
  component: page(() => import('./pages/app/trace.tsx'), 'TracePage'),
});

export const metricsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'metrics',
  staticData: { title: 'Metrics', time: true },
  validateSearch: searchSchema({ view: MetricsView, saved: Schema.String }),
  component: page(() => import('./pages/app/metrics.tsx'), 'MetricsPage'),
});

export const errorsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'errors',
  staticData: { title: 'Errors', time: true },
  validateSearch: searchSchema({
    status: Schema.Literals(['open', 'resolved', 'ignored', 'all']),
    fp: Schema.String,
  }),
  component: page(() => import('./pages/app/errors.tsx'), 'ErrorsPage'),
});

export const alertsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'alerts',
  staticData: { title: 'Alerts', time: true },
  // `draft`: a query to start a new rule from ("Create alert" on a chart).
  validateSearch: searchSchema({ rule: Schema.String, draft: SeriesQuery }),
  component: page(() => import('./pages/app/alerts.tsx'), 'AlertsPage'),
});

export const databaseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'database',
  staticData: { title: 'Database' },
  // `partition`: a partition key value the items are narrowed to.
  validateSearch: searchSchema({ collection: Schema.String, partition: Schema.String }),
  component: page(() => import('./pages/app/database.tsx'), 'DatabasePage'),
});

export const storageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'storage',
  staticData: { title: 'Storage' },
  validateSearch: searchSchema({ store: Schema.String, prefix: Schema.String }),
  component: page(() => import('./pages/app/storage.tsx'), 'StoragePage'),
});

export const deploymentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'deployments',
  staticData: { title: 'Deployments' },
  // `deployment`: the one whose detail is open.
  validateSearch: searchSchema({ deployment: Schema.String }),
  component: page(() => import('./pages/app/deployments.tsx'), 'DeploymentsPage'),
});

const appDashboardsRoute = child(
  'dashboards',
  'Dashboards',
  page(() => import('./pages/dashboards/list.tsx'), 'AppDashboardsPage'),
);

export const appDashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: 'dashboards/$id',
  staticData: { title: 'Dashboard', time: true },
  validateSearch: dashboardSearch,
  component: page(() => import('./pages/dashboards/board.tsx'), 'AppDashboardPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  shellRoute.addChildren([
    appsRoute,
    dashboardsRoute,
    dashboardRoute,
    platformRoute,
    appRoute.addChildren([
      overviewRoute,
      logsRoute,
      tracesRoute,
      traceRoute,
      metricsRoute,
      errorsRoute,
      alertsRoute,
      appDashboardsRoute,
      appDashboardRoute,
      child(
        'jobs',
        'Jobs',
        page(() => import('./pages/app/jobs.tsx'), 'JobsPage'),
        { time: true },
      ),
      child(
        'services',
        'Services',
        page(() => import('./pages/app/services.tsx'), 'ServicesPage'),
        {
          time: true,
        },
      ),
      child(
        'email',
        'Email',
        page(() => import('./pages/app/email.tsx'), 'EmailPage'),
        { time: true },
      ),
      child(
        'realtime',
        'Realtime',
        page(() => import('./pages/app/realtime.tsx'), 'RealtimePage'),
        {
          time: true,
        },
      ),
      databaseRoute,
      storageRoute,
      deploymentsRoute,
      child(
        'secrets',
        'Secrets',
        page(() => import('./pages/app/secrets.tsx'), 'SecretsPage'),
      ),
      child(
        'cost',
        'Cost',
        page(() => import('./pages/app/cost.tsx'), 'CostPage'),
      ),
      child(
        'settings',
        'Settings',
        page(() => import('./pages/app/settings.tsx'), 'SettingsPage'),
      ),
    ]),
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});
