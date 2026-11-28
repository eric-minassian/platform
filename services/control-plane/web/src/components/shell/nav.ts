/**
 * The app sidebar's sections. A section that depends on a building block
 * appears only when the stage's live deployment declares it, so a small app
 * gets a short sidebar.
 */
import type { ResolvedManifest } from '@ericminassian/platform-core';
import {
  Bell,
  ChartGantt,
  ChartSpline,
  CircleDollarSign,
  Database,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Layers,
  ListChecks,
  type LucideIcon,
  Mail,
  Radio,
  ScrollText,
  Settings,
  TriangleAlert,
} from 'lucide-react';

/** The app pages, as router paths. */
export type AppPage =
  | '/apps/$app'
  | '/apps/$app/logs'
  | '/apps/$app/traces'
  | '/apps/$app/metrics'
  | '/apps/$app/errors'
  | '/apps/$app/alerts'
  | '/apps/$app/jobs'
  | '/apps/$app/email'
  | '/apps/$app/realtime'
  | '/apps/$app/database'
  | '/apps/$app/storage'
  | '/apps/$app/deployments'
  | '/apps/$app/secrets'
  | '/apps/$app/cost'
  | '/apps/$app/settings';

export interface NavItem {
  readonly page: AppPage;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Shown only when this returns true for the live manifest (always while it loads). */
  readonly when?: (m: ResolvedManifest) => boolean;
}

export interface NavGroup {
  readonly label?: string;
  readonly items: readonly NavItem[];
}

export const APP_NAV: readonly NavGroup[] = [
  {
    items: [
      { page: '/apps/$app', label: 'Overview', icon: LayoutDashboard },
      { page: '/apps/$app/deployments', label: 'Deployments', icon: Layers },
    ],
  },
  {
    label: 'Observe',
    items: [
      { page: '/apps/$app/logs', label: 'Logs', icon: ScrollText },
      { page: '/apps/$app/traces', label: 'Traces', icon: ChartGantt },
      { page: '/apps/$app/metrics', label: 'Metrics', icon: ChartSpline },
      { page: '/apps/$app/errors', label: 'Errors', icon: TriangleAlert },
      { page: '/apps/$app/alerts', label: 'Alerts', icon: Bell },
    ],
  },
  {
    label: 'Run',
    items: [
      {
        page: '/apps/$app/jobs',
        label: 'Jobs',
        icon: ListChecks,
        when: (m) => Object.keys(m.queues).length + m.events.length + Object.keys(m.crons).length > 0,
      },
      { page: '/apps/$app/email', label: 'Email', icon: Mail, when: (m) => m.email !== undefined },
      { page: '/apps/$app/realtime', label: 'Realtime', icon: Radio, when: (m) => m.realtime !== undefined },
    ],
  },
  {
    label: 'Data',
    items: [
      { page: '/apps/$app/database', label: 'Database', icon: Database, when: (m) => m.db },
      { page: '/apps/$app/storage', label: 'Storage', icon: HardDrive, when: (m) => m.storage.length > 0 },
    ],
  },
  {
    label: 'Configure',
    items: [
      { page: '/apps/$app/secrets', label: 'Secrets', icon: KeyRound },
      { page: '/apps/$app/cost', label: 'Cost', icon: CircleDollarSign },
      { page: '/apps/$app/settings', label: 'Settings', icon: Settings },
    ],
  },
];

/** The page's URL path for an app. */
export const appPath = (app: string, page: AppPage): string => page.replace('$app', encodeURIComponent(app));

/** Whether a sidebar item is the current page: Overview only on its own path, the rest on any page under theirs. */
export function isCurrent(path: string, app: string, page: AppPage): boolean {
  const href = appPath(app, page);
  return page === '/apps/$app'
    ? path === href || path === `${href}/`
    : path === href || path.startsWith(`${href}/`);
}
