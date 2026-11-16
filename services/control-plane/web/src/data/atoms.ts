/**
 * Query atoms shared by several pages. Families are keyed by a stable JSON
 * encoding of their parameters, so two components asking for the same query
 * share one request and one cache entry.
 */
import type { QueryResolution, SeriesQuery } from '@ericminassian/platform-core';
import { Atom } from 'effect/reactivity';
import { ApiClient, fresh, timeToLive } from '../client.ts';
import { apiTime, type TimeSearch } from '../lib/time.ts';

/** JSON with object keys sorted, so equal values encode equally. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** An atom family keyed structurally by `key`. */
export function family<K, A extends object>(make: (key: K) => A): (key: K) => A {
  const byJson = Atom.family((json: string) => make(JSON.parse(json) as K));
  return (key) => byJson(stableJson(key));
}

// ---------------------------------------------------------------------------
// Session and apps
// ---------------------------------------------------------------------------

export const meAtom = fresh(ApiClient.query('session', 'me', { timeToLive }), { staleTime: '5 minutes' });

/** Reactivity key of the apps list. */
export const appsChanged = ['apps'];
/** Reactivity key of one app's summary: mutations that change its record or stages name it. */
export const appChanged = (app: string) => [`app:${app}`];

export const appsAtom = fresh(ApiClient.query('apps', 'list', { reactivityKeys: appsChanged, timeToLive }), {
  every: '60 seconds',
});

export const appAtom = Atom.family((app: string) =>
  fresh(ApiClient.query('apps', 'get', { params: { app }, reactivityKeys: appChanged(app), timeToLive }), {
    every: '30 seconds',
  }),
);

// ---------------------------------------------------------------------------
// Explorer series
// ---------------------------------------------------------------------------

export interface SeriesKey {
  readonly app: string;
  readonly stage: string;
  readonly time: TimeSearch;
  readonly query: SeriesQuery;
  readonly res?: QueryResolution | undefined;
}

export const seriesAtom = family((k: SeriesKey) =>
  fresh(
    ApiClient.query('observe', 'series', {
      params: { app: k.app },
      query: { stage: k.stage, ...apiTime(k.time), ...(k.res ? { res: k.res } : {}), q: k.query },
      timeToLive,
    }),
    { staleTime: '20 seconds' },
  ),
);

// ---------------------------------------------------------------------------
// Deployments: the markers on every time chart
// ---------------------------------------------------------------------------

export const deploymentsChanged = (app: string) => [`deployments:${app}`];

export const deploymentsAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('deployments', 'list', {
      params: { app: k.app },
      query: { stage: k.stage },
      reactivityKeys: deploymentsChanged(k.app),
      timeToLive,
    }),
    { staleTime: '1 minute' },
  ),
);

// ---------------------------------------------------------------------------
// Saved queries, dashboards and alert rules
// ---------------------------------------------------------------------------

export const queriesChanged = (app: string) => [`queries:${app}`];
export const savedQueriesAtom = Atom.family((app: string) =>
  fresh(
    ApiClient.query('queries', 'list', { params: { app }, reactivityKeys: queriesChanged(app), timeToLive }),
  ),
);

export const dashboardsChanged = ['dashboards'];
export const dashboardsAtom = family((k: { app?: string | undefined }) =>
  fresh(
    ApiClient.query('dashboards', 'list', {
      query: k.app ? { app: k.app } : {},
      reactivityKeys: dashboardsChanged,
      timeToLive,
    }),
  ),
);
export const dashboardAtom = Atom.family((id: string) =>
  fresh(
    ApiClient.query('dashboards', 'get', { params: { id }, reactivityKeys: dashboardsChanged, timeToLive }),
  ),
);

export const alertsChanged = (app: string) => [`alerts:${app}`];
export const alertRulesAtom = family((k: { app: string; stage?: string | undefined }) =>
  fresh(
    ApiClient.query('alerts', 'list', {
      params: { app: k.app },
      query: k.stage ? { stage: k.stage } : {},
      reactivityKeys: alertsChanged(k.app),
      timeToLive,
    }),
    { every: '60 seconds' },
  ),
);

// A deployment's manifest never changes, so one read serves the session.
export const deploymentAtom = Atom.family((id: string) =>
  fresh(ApiClient.query('deployments', 'get', { params: { id }, timeToLive }), { staleTime: '1 hour' }),
);
