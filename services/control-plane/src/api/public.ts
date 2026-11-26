/**
 * The public directory (`GET /v1/public/apps`): every app whose live prod
 * deployment is `listed`, with its page views, for anyone to read without
 * signing in. A personal site fetches it from visitors' browsers, so any
 * origin may read it. It says nothing a visitor of the apps couldn't see,
 * and the router caches it.
 */
import {
  type AppRecord,
  bucketStart,
  PROD_STAGE,
  PUBLIC_DIRECTORY_DAYS,
  type PublicApp,
  RESOLUTION_MS,
} from '@ericminassian/platform-core';
import { PlatformApi, PUBLIC_CACHE_CONTROL } from '@ericminassian/platform-core/platform-api';
import { Clock, Effect, Option } from 'effect';
import { HttpEffect, HttpServerResponse } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import type { DeploymentItem, StageItem } from '../records.ts';
import { Store } from '../store.ts';
import { TelemetryQuery } from '../telemetry/query.ts';

const DAY_MS = RESOLUTION_MS['1d'];

/** The `count` UTC days ending with `now`'s, as day starts, oldest first. */
export function directoryDays(now: number, count = PUBLIC_DIRECTORY_DAYS): number[] {
  const today = bucketStart(now, '1d');
  return Array.from({ length: count }, (_, i) => today - (count - 1 - i) * DAY_MS);
}

/** Prod while it serves a deployment (a redeploy in flight still serves the last one). */
export const servesProd = (s: StageItem): boolean =>
  s.stage === PROD_STAGE &&
  s.currentDeployment !== undefined &&
  (s.status === 'active' || s.status === 'deploying');

/**
 * An app's directory entry. `live` is the deployment prod serves; `built` the
 * one whose build it runs, which differs after a compute switch: the platform
 * made that deployment, so it isn't when the app last changed.
 */
export function publicApp(
  app: AppRecord,
  prod: StageItem,
  live: DeploymentItem,
  built: DeploymentItem,
  traffic: { readonly pageViews: readonly number[]; readonly requests: readonly number[] },
): PublicApp {
  const description = live.manifest?.description ?? app.description;
  return {
    name: app.name,
    ...(description ? { description } : {}),
    url: prod.url,
    ...(app.repoVisibility === 'public' ? { source: `https://github.com/${app.repo}` } : {}),
    liveSince: prod.createdAt,
    lastDeployedAt: built.finishedAt ?? built.createdAt,
    up: prod.up ?? null,
    pageViews: [...traffic.pageViews],
    requests: [...traffic.requests],
  };
}

export const PublicLive = HttpApiBuilder.group(
  PlatformApi,
  'public',
  Effect.fn(function* (handlers) {
    const store = yield* Store;
    const telemetry = yield* TelemetryQuery;

    const entry = Effect.fn('directoryEntry')(function* (app: AppRecord, prod: StageItem, days: number[]) {
      const live = yield* store.getDeployment(prod.currentDeployment!);
      if (Option.isNone(live) || live.value.manifest?.listed === false) return Option.none<PublicApp>();
      const built = live.value.computeSwitchOf
        ? Option.getOrElse(yield* store.getDeployment(live.value.computeSwitchOf), () => live.value)
        : live.value;
      const traffic = yield* telemetry.edgeDays(app.name, PROD_STAGE, days);
      return Option.some(publicApp(app, prod, live.value, built, traffic));
    });

    return handlers.handle('apps', () =>
      Effect.gen(function* () {
        yield* HttpEffect.appendPreResponseHandler((_, response) =>
          Effect.succeed(
            HttpServerResponse.setHeaders(response, {
              'cache-control': PUBLIC_CACHE_CONTROL,
              'access-control-allow-origin': '*',
            }),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const days = directoryDays(now);
        const [apps, stages, countingSince] = yield* Effect.all(
          [store.listApps, store.listAllStages, telemetry.edgeCountingSince],
          { concurrency: 'unbounded' },
        );
        const prodOf = new Map(stages.filter(servesProd).map((s) => [s.app, s]));
        const entries = yield* Effect.forEach(
          apps,
          (app) => {
            const prod = prodOf.get(app.name);
            return prod ? entry(app, prod, days) : Effect.succeed(Option.none<PublicApp>());
          },
          { concurrency: 8 },
        );
        return {
          generatedAt: new Date(now).toISOString(),
          days: days.map((d) => new Date(d).toISOString().slice(0, 10)),
          ...(Option.isSome(countingSince) ? { countingSince: countingSince.value } : {}),
          apps: entries.flatMap(Option.toArray).toSorted((a, b) => a.name.localeCompare(b.name)),
        };
      }),
    );
  }),
);
