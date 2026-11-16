/**
 * Alert rules and their history. A rule is an item of the `platform` state
 * table (records.ts); its state changes are rows of the telemetry table
 * (`telemetryKeys.alerts`), kept `ALERT_HISTORY_DAYS` like other telemetry.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  ALERT_HISTORY_DAYS,
  type AlertEvent,
  AlertRule,
  AlertState,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Aws, AwsError, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { alertRuleItem, alertRuleKey } from '../records.ts';
import { type Patch, setExpression } from '../store.ts';

/** State changes a history read returns per stage at most, newest first. */
export const MAX_HISTORY_EVENTS = 500;

/** A history row's sort key: when, then which rule, so a range is a `BETWEEN`. */
const eventSk = (event: Pick<AlertEvent, 'ts' | 'rule'>) => `${event.ts}#${event.rule}`;

const decodeState = Schema.decodeUnknownOption(AlertState);

/** A history row as the API shows it (pure); its time is the sort key's. */
export function toAlertEvent(i: Record<string, unknown>): AlertEvent {
  const sk = String(i.sk);
  const state = (v: unknown) => Option.getOrElse(decodeState(v), () => 'no_data' as const);
  return {
    ts: sk.slice(0, sk.indexOf('#')),
    rule: String(i.rule),
    name: typeof i.name === 'string' ? i.name : '',
    stage: typeof i.stage === 'string' ? i.stage : '',
    from: state(i.from),
    to: state(i.to),
    value: typeof i.value === 'number' ? i.value : null,
    threshold: typeof i.threshold === 'number' ? i.threshold : 0,
  };
}

export class AlertRules extends Context.Service<
  AlertRules,
  {
    /** The app's rules on every stage, oldest first. */
    list(app: string): Effect.Effect<ReadonlyArray<AlertRule>>;
    /** Every app's rules: what the evaluator runs, and the apps list's counts. */
    readonly listAll: Effect.Effect<ReadonlyArray<AlertRule>>;
    get(app: string, id: string): Effect.Effect<Option.Option<AlertRule>>;
    create(rule: AlertRule): Effect.Effect<void>;
    /** Changes a rule's fields (an `undefined` value removes one); none when there is no such rule. */
    update(app: string, id: string, patch: Patch<AlertRule>): Effect.Effect<Option.Option<AlertRule>>;
    /**
     * Records an evaluation of `rule` as it was read. Applies only while its
     * state and `updatedAt` are unchanged, so of two overlapping runs only one
     * moves it (and notifies), and an evaluation of settings someone just
     * changed is dropped; answers whether it applied.
     */
    record(rule: AlertRule, patch: Patch<AlertRule>): Effect.Effect<boolean>;
    /** False when there was no such rule. */
    remove(app: string, id: string): Effect.Effect<boolean>;
    /** Deletes every rule of an app that is being removed. */
    removeAll(app: string): Effect.Effect<void>;
    /** Keeps a state change for `ALERT_HISTORY_DAYS`. */
    addEvent(app: string, event: AlertEvent): Effect.Effect<void>;
    /** A stage's state changes from `from` to `to` (epoch ms), newest first. */
    history(app: string, stage: string, from: number, to: number): Effect.Effect<ReadonlyArray<AlertEvent>>;
  }
>()('@ericminassian/platform-control-plane/AlertRules') {
  static readonly layer: Layer.Layer<AlertRules, never, Aws | Settings> = Layer.effect(
    AlertRules,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const decodeRule = Schema.decodeUnknownEffect(AlertRule);

      const queryAll = Effect.fnUntraced(function* (
        table: string,
        input: Omit<ConstructorParameters<typeof QueryCommand>[0], 'TableName' | 'ExclusiveStartKey'>,
        limit: number = Number.POSITIVE_INFINITY,
      ) {
        const items: Array<Record<string, unknown>> = [];
        let ExclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ddb().send(new QueryCommand({ ...input, TableName: table, ExclusiveStartKey })),
          );
          items.push(...(res.Items ?? []));
          ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey && items.length < limit);
        return items.slice(0, limit);
      });

      const rulesOf = (items: ReadonlyArray<Record<string, unknown>>) =>
        Effect.forEach(items, (item) => decodeRule(item));

      const list = Effect.fn('AlertRules.list')(function* (app: string) {
        const { stateTable } = yield* settings.runtime;
        return yield* rulesOf(
          yield* queryAll(stateTable, {
            KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
            ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'ALERT#' },
          }),
        );
      }, Effect.orDie);

      const listAll = Effect.gen(function* () {
        const { stateTable } = yield* settings.runtime;
        return yield* rulesOf(
          yield* queryAll(stateTable, {
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :p',
            ExpressionAttributeValues: { ':p': 'ALERTS' },
          }),
        );
      }).pipe(Effect.orDie, Effect.withSpan('AlertRules.listAll'));

      const get = Effect.fn('AlertRules.get')(function* (app: string, id: string) {
        const { stateTable } = yield* settings.runtime;
        const res = yield* tryAws(() =>
          aws.ddb().send(new GetCommand({ TableName: stateTable, Key: alertRuleKey(app, id) })),
        );
        return res.Item ? Option.some(yield* decodeRule(res.Item)) : Option.none();
      }, Effect.orDie);

      const create = Effect.fn('AlertRules.create')(function* (rule: AlertRule) {
        const { stateTable } = yield* settings.runtime;
        yield* tryAws(() =>
          aws.ddb().send(
            new PutCommand({
              TableName: stateTable,
              Item: alertRuleItem(rule),
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          ),
        );
      }, Effect.orDie);

      const update = Effect.fn('AlertRules.update')(function* (
        app: string,
        id: string,
        patch: Patch<AlertRule>,
      ) {
        const { stateTable } = yield* settings.runtime;
        const { expr, names, values } = setExpression(patch);
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName: stateTable,
              Key: alertRuleKey(app, id),
              UpdateExpression: expr,
              ExpressionAttributeNames: names,
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              ConditionExpression: 'attribute_exists(pk)',
              ReturnValues: 'ALL_NEW',
            }),
          ),
        ).pipe(
          Effect.asSome,
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.succeedNone),
        );
        if (Option.isNone(res)) return Option.none<AlertRule>();
        return Option.some(yield* decodeRule(res.value.Attributes));
      }, Effect.orDie);

      const record = Effect.fn('AlertRules.record')(function* (rule: AlertRule, patch: Patch<AlertRule>) {
        const { stateTable } = yield* settings.runtime;
        const { expr, names, values } = setExpression(patch);
        return yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName: stateTable,
              Key: alertRuleKey(rule.app, rule.id),
              UpdateExpression: expr,
              ConditionExpression: '#readState = :readState AND #readUpdatedAt = :readUpdatedAt',
              ExpressionAttributeNames: { ...names, '#readState': 'state', '#readUpdatedAt': 'updatedAt' },
              ExpressionAttributeValues: {
                ...values,
                ':readState': rule.state,
                ':readUpdatedAt': rule.updatedAt,
              },
            }),
          ),
        ).pipe(
          Effect.as(true),
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.succeed(false)),
        );
      }, Effect.orDie);

      const remove = Effect.fn('AlertRules.remove')(function* (app: string, id: string) {
        const { stateTable } = yield* settings.runtime;
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new DeleteCommand({
              TableName: stateTable,
              Key: alertRuleKey(app, id),
              ReturnValues: 'ALL_OLD',
            }),
          ),
        );
        return res.Attributes !== undefined;
      }, Effect.orDie);

      const removeAll = Effect.fn('AlertRules.removeAll')(function* (app: string) {
        const rules = yield* list(app);
        yield* Effect.forEach(rules, (r) => remove(app, r.id), { concurrency: 8, discard: true });
      });

      const addEvent = Effect.fn('AlertRules.addEvent')(function* (app: string, event: AlertEvent) {
        const { telemetryTable } = yield* settings.runtime;
        const { ts, ...rest } = event;
        yield* tryAws(() =>
          aws.ddb().send(
            new PutCommand({
              TableName: telemetryTable,
              Item: {
                pk: telemetryKeys.alerts(app, event.stage),
                sk: eventSk(event),
                ...rest,
                ttl: Math.floor(Date.parse(ts) / 1000) + ALERT_HISTORY_DAYS * 86_400,
              },
            }),
          ),
        );
      }, Effect.orDie);

      const history = Effect.fn('AlertRules.history')(function* (
        app: string,
        stage: string,
        from: number,
        to: number,
      ) {
        const { telemetryTable } = yield* settings.runtime;
        const items = yield* queryAll(
          telemetryTable,
          {
            KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
            ExpressionAttributeValues: {
              ':p': telemetryKeys.alerts(app, stage),
              ':a': telemetryKeys.time(from),
              ':b': `${telemetryKeys.time(to)}￿`,
            },
            ScanIndexForward: false,
          },
          MAX_HISTORY_EVENTS,
        );
        return items.map(toAlertEvent);
      }, Effect.orDie);

      return AlertRules.of({
        list,
        listAll,
        get,
        create,
        update,
        record,
        remove,
        removeAll,
        addEvent,
        history,
      });
    }),
  );

  /**
   * The same in memory, for tests; `rules` and `events` seed it. Every use
   * of the layer shares one copy, so a test can read what a request left.
   */
  static readonly memory = (
    seed: {
      readonly rules?: ReadonlyArray<AlertRule>;
      readonly events?: ReadonlyArray<AlertEvent & { readonly app: string }>;
    } = {},
  ): Layer.Layer<AlertRules> =>
    Layer.succeed(
      AlertRules,
      (() => {
        const rules = new Map((seed.rules ?? []).map((r) => [`${r.app}#${r.id}`, r]));
        const events = new Map<string, AlertEvent[]>();
        const eventsOf = (app: string, stage: string) => {
          const key = `${app}#${stage}`;
          const list = events.get(key) ?? [];
          events.set(key, list);
          return list;
        };
        for (const { app, ...event } of seed.events ?? []) eventsOf(app, event.stage).push(event);
        const sorted = () => [...rules.values()].toSorted((a, b) => a.id.localeCompare(b.id));
        const apply = (rule: AlertRule, patch: Patch<AlertRule>): AlertRule => {
          const next: Record<string, unknown> = { ...rule };
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete next[k];
            else next[k] = v;
          }
          return next as AlertRule;
        };
        return AlertRules.of({
          list: (app) => Effect.sync(() => sorted().filter((r) => r.app === app)),
          listAll: Effect.sync(sorted),
          get: (app, id) => Effect.sync(() => Option.fromNullishOr(rules.get(`${app}#${id}`))),
          create: (rule) =>
            Effect.sync(() => {
              rules.set(`${rule.app}#${rule.id}`, rule);
            }),
          update: (app, id, patch) =>
            Effect.sync(() => {
              const current = rules.get(`${app}#${id}`);
              if (!current) return Option.none();
              const next = apply(current, patch);
              rules.set(`${app}#${id}`, next);
              return Option.some(next);
            }),
          record: (rule, patch) =>
            Effect.sync(() => {
              const current = rules.get(`${rule.app}#${rule.id}`);
              if (!current || current.state !== rule.state || current.updatedAt !== rule.updatedAt)
                return false;
              rules.set(`${rule.app}#${rule.id}`, apply(current, patch));
              return true;
            }),
          remove: (app, id) => Effect.sync(() => rules.delete(`${app}#${id}`)),
          removeAll: (app) =>
            Effect.sync(() => {
              for (const [key, r] of rules) if (r.app === app) rules.delete(key);
            }),
          addEvent: (app, event) =>
            Effect.sync(() => {
              eventsOf(app, event.stage).push(event);
            }),
          history: (app, stage, from, to) =>
            Effect.sync(() =>
              eventsOf(app, stage)
                .filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= to)
                .toSorted((a, b) => eventSk(b).localeCompare(eventSk(a)))
                .slice(0, MAX_HISTORY_EVENTS),
            ),
        });
      })(),
    );
}
