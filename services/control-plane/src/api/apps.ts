/** Registering apps, and the summaries the console's home and `plat apps` show. */
import {
  type AlertRule,
  type AppRecord,
  type AppSummary,
  PROD_STAGE,
  stageHost,
  validateAppName,
} from '@ericminassian/platform-core';
import { BadRequest, Conflict, LimitReached, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AlertRules } from '../alerts/rules.ts';
import { canAccessApp, canCreateApp } from '../authz.ts';
import { Settings } from '../config.ts';
import { Dns } from '../dns.ts';
import { type Patch, Store } from '../store.ts';
import { TelemetryQuery } from '../telemetry/query.ts';
import { Access, publicDeployment, publicStage } from './access.ts';

/** Telemetry a view shows if it can read it; the view is still useful without. */
export const ifAvailable = <A>(what: string, effect: Effect.Effect<A>): Effect.Effect<Option.Option<A>> =>
  effect.pipe(
    Effect.asSome,
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning(`app summary without ${what}`, cause), Option.none<A>()),
    ),
  );

type AlertCounts = NonNullable<AppSummary['alerts']>;

/** Each app's rules and how many of them are firing (enabled and in alarm), by app (pure). */
export function alertCounts(rules: ReadonlyArray<AlertRule>): Map<string, AlertCounts> {
  const out = new Map<string, AlertCounts>();
  for (const r of rules) {
    const prev = out.get(r.app) ?? { total: 0, alarm: 0 };
    out.set(r.app, { total: prev.total + 1, alarm: prev.alarm + (r.enabled && r.state === 'alarm' ? 1 : 0) });
  }
  return out;
}

export const AppsLive = HttpApiBuilder.group(
  PlatformApi,
  'apps',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const alerts = yield* AlertRules;
    const dns = yield* Dns;
    const settings = yield* Settings;
    const store = yield* Store;
    const telemetry = yield* TelemetryQuery;
    const exists = (name: string) => new Conflict({ code: 'exists', message: `app ${name} already exists` });

    /** `alerts`: the app's counts, when the rules could be read. */
    const summarize = Effect.fn('summarize')(function* (
      app: AppRecord,
      alertsOf: Option.Option<AlertCounts>,
    ) {
      const [stages, deployments, cost] = yield* Effect.all(
        [
          store.listStages(app.name),
          store.listDeployments(app.name, 1),
          ifAvailable('cost', telemetry.cost(app.name)),
        ],
        { concurrency: 'unbounded' },
      );
      const prod = stages.find((s) => s.stage === PROD_STAGE && s.status === 'active');
      const [health, traffic] = prod
        ? yield* Effect.all(
            [
              ifAvailable('health', telemetry.health(app.name, prod.up ?? null)),
              ifAvailable('traffic', telemetry.traffic(app.name)),
            ],
            { concurrency: 'unbounded' },
          )
        : [Option.none(), Option.none()];
      const lastDeployment = deployments[0];
      return {
        app,
        stages: stages.filter((s) => s.status !== 'destroyed').map(publicStage),
        health: Option.getOrNull(health),
        ...(Option.isSome(cost) ? { costMonthToDateUsd: cost.value.monthToDateUsd } : {}),
        ...(lastDeployment ? { lastDeployment: publicDeployment(lastDeployment) } : {}),
        ...(Option.isSome(traffic) ? { traffic: traffic.value } : {}),
        ...(Option.isSome(alertsOf) ? { alerts: alertsOf.value } : {}),
      } satisfies AppSummary;
    });

    const noAlerts: AlertCounts = { total: 0, alarm: 0 };

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const me = yield* access.member;
          const visible = (yield* store.listApps).filter((a) => canAccessApp(me, a));
          // One read of every app's rules rather than one per app.
          const counts = yield* ifAvailable('alerts', Effect.map(alerts.listAll, alertCounts));
          const summaries = yield* Effect.forEach(
            visible,
            (app) =>
              summarize(
                app,
                Option.map(counts, (c) => c.get(app.name) ?? noAlerts),
              ),
            { concurrency: 8 },
          );
          return summaries.toSorted((x, y) => x.app.name.localeCompare(y.app.name));
        }),

      create: ({ payload }) =>
        Effect.gen(function* () {
          const me = yield* access.member;
          const { name, repo } = payload;
          const nameErr = validateAppName(name, settings.platform.reservedAppNames);
          if (nameErr) return yield* BadRequest.of(nameErr);
          if (Option.isSome(yield* store.getApp(name))) return yield* exists(name);
          const mine = (yield* store.listApps).filter(
            (a) => a.createdBy.toLowerCase() === me.github.toLowerCase(),
          ).length;
          const allowed = canCreateApp(me, mine, settings.platform);
          if (!allowed.ok) return yield* LimitReached.of(allowed.reason);
          const conflict = yield* dns.hostConflict(
            stageHost(name, PROD_STAGE, settings.platform.domain),
            settings.platform.edgeHost,
          );
          if (Option.isSome(conflict))
            return yield* new Conflict({ code: 'dns_conflict', message: conflict.value });
          const record: AppRecord = {
            name,
            repo,
            ...(payload.description ? { description: payload.description } : {}),
            owners: [me.github],
            createdBy: me.github,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          };
          // Another request may have registered the name since the check above.
          yield* store
            .createApp(record)
            .pipe(Effect.catchTag('AlreadyExists', () => Effect.fail(exists(name))));
          return record;
        }),

      get: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const counts = yield* ifAvailable(
            'alerts',
            Effect.map(alerts.list(app.name), (rules) => alertCounts(rules).get(app.name) ?? noAlerts),
          );
          return yield* summarize(app, counts);
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const patch: Patch<AppRecord> = {
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.repo !== undefined ? { repo: payload.repo } : {}),
            ...(payload.owners !== undefined ? { owners: [...new Set(payload.owners)] } : {}),
          };
          if (Object.keys(patch).length === 0) return app;
          return yield* store.updateApp(app.name, patch);
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const live = (yield* store.listStages(app.name)).filter((s) => s.status !== 'destroyed');
          if (live.length) {
            return yield* new Conflict({
              code: 'has_stages',
              message: `destroy stages first: ${live.map((s) => s.stage).join(', ')}`,
            });
          }
          // Its rules first: an app registered again under the name starts without them,
          // and removing them again is harmless where orphans aren't.
          yield* alerts.removeAll(app.name);
          return yield* store.deleteApp(app.name);
        }),
    });
  }),
);
