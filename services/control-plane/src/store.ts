/**
 * Control plane state in the `platform` table (single-table design). The item
 * layout lives in records.ts, which the foundation also uses. Items are
 * decoded with their schemas, so a malformed item is a defect, not a value.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { AppRecord, type DeploymentEventEntry, type DeploymentStatus } from '@ericminassian/platform-core';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { Aws, AwsError, tryAws } from './aws.ts';
import { Settings } from './config.ts';
import {
  appItem,
  appKey,
  DeploymentItem,
  deploymentItem,
  deploymentKey,
  StageItem,
  stageItem,
  stageKey,
} from './records.ts';

export { DeploymentItem, StageItem } from './records.ts';

/** `createApp` found an app with that name. */
export class AlreadyExists extends Schema.TaggedError<AlreadyExists, { readonly brand: unique symbol }>()(
  'AlreadyExists',
  {},
) {}

/** Fields to change; an `undefined` value removes the attribute. */
export type Patch<T> = { readonly [K in keyof T]?: T[K] | undefined };

const MAX_EVENTS = 500;

export class Store extends Context.Service<
  Store,
  {
    getApp(name: string): Effect.Effect<Option.Option<AppRecord>>;
    readonly listApps: Effect.Effect<ReadonlyArray<AppRecord>>;
    createApp(app: AppRecord): Effect.Effect<void, AlreadyExists>;
    updateApp(name: string, patch: Patch<AppRecord>): Effect.Effect<AppRecord>;
    deleteApp(name: string): Effect.Effect<void>;

    getStage(app: string, stage: string): Effect.Effect<Option.Option<StageItem>>;
    listStages(app: string): Effect.Effect<ReadonlyArray<StageItem>>;
    readonly listAllStages: Effect.Effect<ReadonlyArray<StageItem>>;
    putStage(stage: StageItem): Effect.Effect<void>;
    /** Also sets `updatedAt`. */
    updateStage(app: string, stage: string, patch: Patch<StageItem>): Effect.Effect<StageItem>;

    createDeployment(deployment: DeploymentItem): Effect.Effect<void>;
    getDeployment(id: string): Effect.Effect<Option.Option<DeploymentItem>>;
    /** Newest first. */
    listDeployments(app: string, limit?: number): Effect.Effect<ReadonlyArray<DeploymentItem>>;
    /**
     * With `ifStatus`, applies only when the current status matches and
     * answers false otherwise, so the deploy job is idempotent under retries.
     */
    updateDeployment(
      app: string,
      id: string,
      patch: Patch<DeploymentItem>,
      ifStatus?: DeploymentStatus,
    ): Effect.Effect<boolean>;
    /** Appends to the event log, up to 500 entries. */
    appendDeploymentEvents(
      app: string,
      id: string,
      events: ReadonlyArray<DeploymentEventEntry>,
    ): Effect.Effect<void>;
  }
>()('@ericminassian/platform-control-plane/Store') {
  static readonly layer: Layer.Layer<Store, never, Aws | Settings> = Layer.effect(
    Store,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const table = Effect.map(settings.runtime, (r) => r.stateTable);

      const decodeApp = Schema.decodeUnknownEffect(AppRecord);
      const decodeStage = Schema.decodeUnknownEffect(StageItem);
      const decodeDeployment = Schema.decodeUnknownEffect(DeploymentItem);

      const queryAll = Effect.fnUntraced(function* (
        input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
        limit = Number.POSITIVE_INFINITY,
      ) {
        const TableName = yield* table;
        const items: Array<Record<string, unknown>> = [];
        let ExclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ddb().send(new QueryCommand({ ...input, TableName, ExclusiveStartKey })),
          );
          items.push(...(res.Items ?? []));
          ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey && items.length < limit);
        return items.slice(0, limit);
      });

      const getItem = Effect.fnUntraced(function* (Key: Record<string, string>, ConsistentRead?: boolean) {
        const TableName = yield* table;
        const res = yield* tryAws(() =>
          aws.ddb().send(new GetCommand({ TableName, Key, ...(ConsistentRead ? { ConsistentRead } : {}) })),
        );
        return Option.fromNullishOr(res.Item);
      });

      const getApp = Effect.fn('Store.getApp')(function* (name: string) {
        const item = yield* getItem(appKey(name));
        return Option.isSome(item) ? Option.some(yield* decodeApp(item.value)) : Option.none();
      }, Effect.orDie);

      const listApps = queryAll({
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': 'APPS' },
      }).pipe(
        Effect.flatMap((items) => Effect.forEach(items, (item) => decodeApp(item))),
        Effect.orDie,
        Effect.withSpan('Store.listApps'),
      );

      const createApp = Effect.fn('Store.createApp')(function* (app: AppRecord) {
        const TableName = yield* table;
        yield* tryAws(() =>
          aws.ddb().send(
            new PutCommand({
              TableName,
              Item: appItem(app),
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          ),
        ).pipe(
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => new AlreadyExists()),
          Effect.catchTag('AwsError', Effect.die),
        );
      });

      const updateApp = Effect.fn('Store.updateApp')(function* (name: string, patch: Patch<AppRecord>) {
        const TableName = yield* table;
        const { expr, names, values } = setExpression(patch);
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName,
              Key: appKey(name),
              UpdateExpression: expr,
              ExpressionAttributeNames: names,
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              ConditionExpression: 'attribute_exists(pk)',
              ReturnValues: 'ALL_NEW',
            }),
          ),
        );
        return yield* decodeApp(res.Attributes);
      }, Effect.orDie);

      const deleteApp = Effect.fn('Store.deleteApp')(function* (name: string) {
        const TableName = yield* table;
        yield* tryAws(() => aws.ddb().send(new DeleteCommand({ TableName, Key: appKey(name) })));
      }, Effect.orDie);

      const getStage = Effect.fn('Store.getStage')(function* (app: string, stage: string) {
        const item = yield* getItem(stageKey(app, stage));
        return Option.isSome(item) ? Option.some(yield* decodeStage(item.value)) : Option.none();
      }, Effect.orDie);

      const listStages = Effect.fn('Store.listStages')(function* (app: string) {
        const items = yield* queryAll({
          KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
          ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'STAGE#' },
        });
        return yield* Effect.forEach(items, (item) => decodeStage(item));
      }, Effect.orDie);

      const listAllStages = queryAll({
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': 'STAGES' },
      }).pipe(
        Effect.flatMap((items) => Effect.forEach(items, (item) => decodeStage(item))),
        Effect.orDie,
        Effect.withSpan('Store.listAllStages'),
      );

      const putStage = Effect.fn('Store.putStage')(function* (stage: StageItem) {
        const TableName = yield* table;
        yield* tryAws(() => aws.ddb().send(new PutCommand({ TableName, Item: stageItem(stage) })));
      }, Effect.orDie);

      const updateStage = Effect.fn('Store.updateStage')(function* (
        app: string,
        stage: string,
        patch: Patch<StageItem>,
      ) {
        const TableName = yield* table;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        const { expr, names, values } = setExpression({ ...patch, updatedAt });
        const res = yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName,
              Key: stageKey(app, stage),
              UpdateExpression: expr,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
              ReturnValues: 'ALL_NEW',
            }),
          ),
        );
        return yield* decodeStage(res.Attributes);
      }, Effect.orDie);

      const createDeployment = Effect.fn('Store.createDeployment')(function* (deployment: DeploymentItem) {
        const TableName = yield* table;
        yield* tryAws(() =>
          aws.ddb().send(
            new PutCommand({
              TableName,
              Item: deploymentItem(deployment),
              ConditionExpression: 'attribute_not_exists(pk)',
            }),
          ),
        );
      }, Effect.orDie);

      const getDeployment = Effect.fn('Store.getDeployment')(function* (id: string) {
        const [found] = yield* queryAll(
          {
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :p AND gsi1sk = :s',
            ExpressionAttributeValues: { ':p': `DEP#${id}`, ':s': 'DEP' },
          },
          1,
        );
        if (!found) return Option.none();
        // GSI reads are eventually consistent; re-read from the base table for the latest status.
        const item = yield* getItem({ pk: String(found.pk), sk: String(found.sk) }, true);
        return Option.isSome(item) ? Option.some(yield* decodeDeployment(item.value)) : Option.none();
      }, Effect.orDie);

      const listDeployments = Effect.fn('Store.listDeployments')(function* (app: string, limit = 50) {
        const items = yield* queryAll(
          {
            KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
            ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'DEP#' },
            ScanIndexForward: false,
            Limit: limit,
          },
          limit,
        );
        return yield* Effect.forEach(items, (item) => decodeDeployment(item));
      }, Effect.orDie);

      const updateDeployment = Effect.fn('Store.updateDeployment')(function* (
        app: string,
        id: string,
        patch: Patch<DeploymentItem>,
        ifStatus?: DeploymentStatus,
      ) {
        const TableName = yield* table;
        const { expr, names, values } = setExpression(patch);
        return yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName,
              Key: deploymentKey(app, id),
              UpdateExpression: expr,
              ExpressionAttributeNames: { ...names, ...(ifStatus ? { '#status': 'status' } : {}) },
              ExpressionAttributeValues: { ...values, ...(ifStatus ? { ':ifStatus': ifStatus } : {}) },
              ConditionExpression: ifStatus ? '#status = :ifStatus' : 'attribute_exists(pk)',
            }),
          ),
        ).pipe(
          Effect.as(true),
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.succeed(false)),
        );
      }, Effect.orDie);

      const appendDeploymentEvents = Effect.fn('Store.appendDeploymentEvents')(function* (
        app: string,
        id: string,
        events: ReadonlyArray<DeploymentEventEntry>,
      ) {
        if (events.length === 0) return;
        const TableName = yield* table;
        yield* tryAws(() =>
          aws.ddb().send(
            new UpdateCommand({
              TableName,
              Key: deploymentKey(app, id),
              UpdateExpression: 'SET #e = list_append(if_not_exists(#e, :empty), :events)',
              ConditionExpression: 'size(#e) < :max OR attribute_not_exists(#e)',
              ExpressionAttributeNames: { '#e': 'events' },
              ExpressionAttributeValues: { ':empty': [], ':events': events, ':max': MAX_EVENTS },
            }),
          ),
        ).pipe(
          // A full log keeps its first 500 entries.
          Effect.catchIf(AwsError.is('ConditionalCheckFailedException'), () => Effect.void),
        );
      }, Effect.orDie);

      return Store.of({
        getApp,
        listApps,
        createApp,
        updateApp,
        deleteApp,
        getStage,
        listStages,
        listAllStages,
        putStage,
        updateStage,
        createDeployment,
        getDeployment,
        listDeployments,
        updateDeployment,
        appendDeploymentEvents,
      });
    }),
  );
}

/** Builds `SET #k0 = :v0, ... REMOVE #k1` for a partial update. */
function setExpression(patch: Readonly<Record<string, unknown>>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  Object.entries(patch).forEach(([k, v], i) => {
    names[`#k${i}`] = k;
    if (v === undefined) removes.push(`#k${i}`);
    else {
      values[`:v${i}`] = v;
      sets.push(`#k${i} = :v${i}`);
    }
  });
  const expr = [
    sets.length ? `SET ${sets.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { expr, names, values };
}
