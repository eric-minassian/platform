/** Alert rules of an app's stages, and their state changes. The evaluator is alerts/evaluator.ts. */
import {
  type AlertRule,
  type AlertRuleInput,
  checkSeriesQuery,
  MAX_ALERT_RULES_PER_APP,
  newId,
} from '@ericminassian/platform-core';
import { BadRequest, LimitReached, NotFound, PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Clock, DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AlertRules } from '../alerts/rules.ts';
import { Store } from '../store.ts';
import { parseRange } from '../telemetry/query.ts';
import { Access, stageParam } from './access.ts';

/** JSON with object keys sorted, so two queries compare by what they ask. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)))
      : value,
  );

/**
 * Whether new settings make a rule's state meaningless: another stage, query
 * or condition watches something else, so it starts over in `no_data` (pure).
 */
export function resetsState(rule: AlertRuleInput, next: AlertRuleInput): boolean {
  return (
    rule.stage !== next.stage ||
    canonical(rule.query) !== canonical(next.query) ||
    canonical(rule.condition) !== canonical(next.condition)
  );
}

export const AlertsLive = HttpApiBuilder.group(
  PlatformApi,
  'alerts',
  Effect.fn(function* (handlers) {
    const access = yield* Access;
    const rules = yield* AlertRules;
    const store = yield* Store;

    /** A rule's settings, checked: a valid stage name and a query a rule can watch. */
    const checked = Effect.fnUntraced(function* (input: AlertRuleInput) {
      const stage = yield* stageParam(input.stage);
      const problem = checkSeriesQuery(input.query, { alert: true });
      if (problem) return yield* BadRequest.of(problem);
      return { ...input, stage };
    });

    const found = Effect.fnUntraced(function* (app: string, id: string) {
      const rule = yield* rules.get(app, id);
      if (Option.isNone(rule)) return yield* NotFound.of(`alert rule ${id}`);
      return rule.value;
    });

    return handlers.handleAll({
      list: ({ params, query }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const stage = query.stage === undefined ? undefined : yield* stageParam(query.stage);
          const all = yield* rules.list(app.name);
          return stage ? all.filter((r) => r.stage === stage) : all;
        }),

      create: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app, member } = yield* access.memberApp(params.app);
          const input = yield* checked(payload);
          if ((yield* rules.list(app.name)).length >= MAX_ALERT_RULES_PER_APP)
            return yield* LimitReached.of(`an app has at most ${MAX_ALERT_RULES_PER_APP} alert rules`);
          const now = DateTime.formatIso(yield* DateTime.now);
          const rule: AlertRule = {
            id: newId('a'),
            app: app.name,
            ...input,
            state: 'no_data',
            stateSince: now,
            createdBy: member.github,
            createdAt: now,
            updatedAt: now,
          };
          yield* rules.create(rule);
          return rule;
        }),

      update: ({ params, payload }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const input = yield* checked(payload);
          const current = yield* found(app.name, params.id);
          const now = DateTime.formatIso(yield* DateTime.now);
          const reset = resetsState(current, input);
          const updated = yield* rules.update(app.name, params.id, {
            ...input,
            updatedAt: now,
            ...(reset ? { state: 'no_data', stateSince: now, value: undefined, evaluatedAt: undefined } : {}),
          });
          if (Option.isNone(updated)) return yield* NotFound.of(`alert rule ${params.id}`);
          return updated.value;
        }),

      remove: ({ params }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          yield* rules.remove(app.name, params.id).pipe(
            Effect.filterOrFail(
              (removed) => removed,
              () => NotFound.of(`alert rule ${params.id}`),
            ),
          );
        }),

      history: ({ params, query }) =>
        Effect.gen(function* () {
          const { app } = yield* access.memberApp(params.app);
          const range = parseRange({ ...query, range: query.range ?? '7d' }, yield* Clock.currentTimeMillis);
          // Every stage that has or had rules: the app's stages, and those its rules name.
          const stages =
            query.stage !== undefined
              ? [yield* stageParam(query.stage)]
              : [
                  ...new Set([
                    ...(yield* store.listStages(app.name)).map((s) => s.stage),
                    ...(yield* rules.list(app.name)).map((r) => r.stage),
                  ]),
                ];
          const perStage = yield* Effect.forEach(
            stages,
            (stage) => rules.history(app.name, stage, range.from, range.to),
            { concurrency: 4 },
          );
          return {
            events: perStage
              .flat()
              .toSorted((a, b) => b.ts.localeCompare(a.ts) || b.rule.localeCompare(a.rule)),
          };
        }),
    });
  }),
);
