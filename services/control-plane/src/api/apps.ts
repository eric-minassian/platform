/** Registering apps, and the summaries the console's home and `plat apps` show. */
import {
  type AppRecord,
  type AppSummary,
  PROD_STAGE,
  stageHost,
  validateAppName,
} from '@ericminassian/platform-core';
import { BadRequest, Conflict, LimitReached, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
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

export const AppsLive = HttpApiBuilder.group(
  PlatformApi,
  'apps',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const dns = yield* Dns;
    const settings = yield* Settings;
    const store = yield* Store;
    const telemetry = yield* TelemetryQuery;
    const exists = (name: string) => new Conflict({ code: 'exists', message: `app ${name} already exists` });

    const summarize = Effect.fn('summarize')(function* (app: AppRecord) {
      const [stages, deployments, cost] = yield* Effect.all(
        [
          store.listStages(app.name),
          store.listDeployments(app.name, 1),
          ifAvailable('cost', telemetry.cost(app.name)),
        ],
        { concurrency: 'unbounded' },
      );
      const prod = stages.find((s) => s.stage === PROD_STAGE && s.status === 'active');
      const health = prod
        ? yield* ifAvailable('health', telemetry.health(app.name, prod.up ?? null))
        : Option.none();
      const lastDeployment = deployments[0];
      return {
        app,
        stages: stages.filter((s) => s.status !== 'destroyed').map(publicStage),
        health: Option.getOrNull(health),
        ...(Option.isSome(cost) ? { costMonthToDateUsd: cost.value.monthToDateUsd } : {}),
        ...(lastDeployment ? { lastDeployment: publicDeployment(lastDeployment) } : {}),
      } satisfies AppSummary;
    });

    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const me = yield* access.member;
          const visible = (yield* store.listApps).filter((a) => canAccessApp(me, a));
          const summaries = yield* Effect.forEach(visible, summarize, { concurrency: 8 });
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
          return yield* summarize(app);
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
          yield* store.deleteApp(app.name);
        }),
    });
  }),
);
