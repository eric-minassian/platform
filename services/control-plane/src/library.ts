/**
 * Saved queries and dashboards: what members keep of the explorer, log and
 * trace views, in the `platform` state table (layout in records.ts).
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  checkSeriesQuery,
  Dashboard,
  DASHBOARD_COLUMNS,
  type MetricsView,
  type QueryView,
  type SaveDashboardRequest,
  SavedQuery,
  validateStageName,
} from '@ericminassian/platform-core';
import { absurd, Context, Effect, Layer, Option, Schema } from 'effect';
import { Aws, tryAws } from './aws.ts';
import { Settings } from './config.ts';
import { checkLogFilters, checkTraceFilters, checkUserQuery } from './insights.ts';
import { CROSS_APP, dashboardItem, dashboardKey, savedQueryItem, savedQueryKey } from './records.ts';

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Why a chart's queries can't be kept: each must be answerable, and ids name one query or expression each. */
function checkMetricsView(view: MetricsView): string | undefined {
  const ids = new Set<string>();
  for (const q of view.queries) {
    if (ids.has(q.id)) return `two queries are named ${q.id}`;
    ids.add(q.id);
    const problem = checkSeriesQuery(q);
    if (problem) return `${q.id}: ${problem}`;
    const stage = q.stage === undefined ? undefined : validateStageName(q.stage);
    if (stage) return `${q.id}: ${stage}`;
  }
  for (const e of view.expressions ?? []) {
    if (ids.has(e.id)) return `two queries are named ${e.id}`;
    ids.add(e.id);
  }
  return undefined;
}

/** Why a view can't be saved (as a query or a widget), or undefined: what would fail when it runs is refused now. */
export function checkView(view: QueryView): string | undefined {
  switch (view.kind) {
    case 'metrics':
      return checkMetricsView(view);
    case 'logs':
      return (
        checkLogFilters(view.filters) ??
        (view.insights === undefined ? undefined : checkUserQuery(view.insights))
      );
    case 'traces':
      return checkTraceFilters(view.filters);
    default:
      return absurd(view);
  }
}

/** Why a saved query can't be kept, or undefined. */
export function checkSavedQuery(q: {
  readonly view: QueryView;
  readonly stage?: string | undefined;
}): string | undefined {
  return (q.stage === undefined ? undefined : validateStageName(q.stage)) ?? checkView(q.view);
}

/** Why a dashboard can't be kept: widget ids are unique, widgets fit the grid, and each view could run. */
export function checkDashboard(d: SaveDashboardRequest): string | undefined {
  const ids = new Set<string>();
  for (const w of d.widgets) {
    if (ids.has(w.id)) return `two widgets are named ${w.id}`;
    ids.add(w.id);
    if (w.x + w.w > DASHBOARD_COLUMNS)
      return `widget ${w.id} runs past the grid's ${DASHBOARD_COLUMNS} columns`;
    const stage = w.stage === undefined ? undefined : validateStageName(w.stage);
    if (stage) return `widget ${w.id}: ${stage}`;
    const problem = checkView(w.view);
    if (problem) return `widget ${w.id}: ${problem}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class Library extends Context.Service<
  Library,
  {
    /** An app's saved queries, oldest first. */
    listQueries(app: string): Effect.Effect<ReadonlyArray<SavedQuery>>;
    getQuery(app: string, id: string): Effect.Effect<Option.Option<SavedQuery>>;
    /** Creates or replaces it. */
    putQuery(query: SavedQuery): Effect.Effect<void>;
    deleteQuery(app: string, id: string): Effect.Effect<void>;
    /** An app's dashboards and the cross-app ones; without `app`, every dashboard. */
    listDashboards(app?: string): Effect.Effect<ReadonlyArray<Dashboard>>;
    getDashboard(id: string): Effect.Effect<Option.Option<Dashboard>>;
    /** Creates or replaces it. */
    putDashboard(dashboard: Dashboard): Effect.Effect<void>;
    deleteDashboard(id: string): Effect.Effect<void>;
    /** Deletes an app's saved queries and dashboards, as the app is removed. */
    removeApp(app: string): Effect.Effect<void>;
  }
>()('@ericminassian/platform-control-plane/Library') {
  static readonly layer: Layer.Layer<Library, never, Aws | Settings> = Layer.effect(
    Library,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;
      const table = Effect.map(settings.runtime, (r) => r.stateTable);
      const decodeQuery = Schema.decodeUnknownEffect(SavedQuery);
      const decodeDashboard = Schema.decodeUnknownEffect(Dashboard);

      const queryAll = Effect.fnUntraced(function* (
        input: Omit<QueryCommandInput, 'TableName' | 'ExclusiveStartKey'>,
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
        } while (ExclusiveStartKey);
        return items;
      });

      const getItem = Effect.fnUntraced(function* (Key: Record<string, string>) {
        const TableName = yield* table;
        const res = yield* tryAws(() => aws.ddb().send(new GetCommand({ TableName, Key })));
        return Option.fromNullishOr(res.Item);
      });

      const put = Effect.fnUntraced(function* (Item: Record<string, unknown>) {
        const TableName = yield* table;
        yield* tryAws(() => aws.ddb().send(new PutCommand({ TableName, Item })));
      });

      const remove = Effect.fnUntraced(function* (Key: Record<string, string>) {
        const TableName = yield* table;
        yield* tryAws(() => aws.ddb().send(new DeleteCommand({ TableName, Key })));
      });

      const listQueries = Effect.fn('Library.listQueries')(function* (app: string) {
        const items = yield* queryAll({
          KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
          ExpressionAttributeValues: { ':p': `APP#${app}`, ':s': 'QUERY#' },
        });
        return yield* Effect.forEach(items, (item) => decodeQuery(item));
      }, Effect.orDie);

      const getQuery = Effect.fn('Library.getQuery')(function* (app: string, id: string) {
        const item = yield* getItem(savedQueryKey(app, id));
        return Option.isSome(item) ? Option.some(yield* decodeQuery(item.value)) : Option.none();
      }, Effect.orDie);

      const listDashboards = Effect.fn('Library.listDashboards')(function* (app?: string) {
        const items = yield* queryAll(
          app === undefined
            ? {
                IndexName: 'gsi1',
                KeyConditionExpression: 'gsi1pk = :p',
                ExpressionAttributeValues: { ':p': 'DASHBOARDS' },
              }
            : {
                // From the app's own to the end of the cross-app ones; other apps' in between are filtered out.
                IndexName: 'gsi1',
                KeyConditionExpression: 'gsi1pk = :p AND gsi1sk BETWEEN :from AND :to',
                FilterExpression: '#app = :app OR attribute_not_exists(#app)',
                ExpressionAttributeNames: { '#app': 'app' },
                ExpressionAttributeValues: {
                  ':p': 'DASHBOARDS',
                  ':from': `${app}#`,
                  ':to': `${CROSS_APP}#￿`,
                  ':app': app,
                },
              },
        );
        return yield* Effect.forEach(items, (item) => decodeDashboard(item));
      }, Effect.orDie);

      const getDashboard = Effect.fn('Library.getDashboard')(function* (id: string) {
        const item = yield* getItem(dashboardKey(id));
        return Option.isSome(item) ? Option.some(yield* decodeDashboard(item.value)) : Option.none();
      }, Effect.orDie);

      const removeApp = Effect.fn('Library.removeApp')(function* (app: string) {
        const [queries, dashboards] = yield* Effect.all([
          listQueries(app),
          queryAll({
            IndexName: 'gsi1',
            KeyConditionExpression: 'gsi1pk = :p AND begins_with(gsi1sk, :s)',
            ExpressionAttributeValues: { ':p': 'DASHBOARDS', ':s': `${app}#` },
          }),
        ]);
        yield* Effect.forEach(
          [
            ...queries.map((q) => savedQueryKey(app, q.id)),
            ...dashboards.map((d) => dashboardKey(String(d.id))),
          ],
          remove,
          { concurrency: 8, discard: true },
        );
      }, Effect.orDie);

      return Library.of({
        listQueries,
        getQuery,
        putQuery: (query) =>
          put(savedQueryItem(query)).pipe(Effect.orDie, Effect.withSpan('Library.putQuery')),
        deleteQuery: (app, id) =>
          remove(savedQueryKey(app, id)).pipe(Effect.orDie, Effect.withSpan('Library.deleteQuery')),
        listDashboards,
        getDashboard,
        putDashboard: (dashboard) =>
          put(dashboardItem(dashboard)).pipe(Effect.orDie, Effect.withSpan('Library.putDashboard')),
        deleteDashboard: (id) =>
          remove(dashboardKey(id)).pipe(Effect.orDie, Effect.withSpan('Library.deleteDashboard')),
        removeApp,
      });
    }),
  );

  /** The library in memory, for tests. */
  static readonly memory = (): Layer.Layer<Library> =>
    Layer.sync(Library, () => {
      const queries = new Map<string, SavedQuery>();
      const dashboards = new Map<string, Dashboard>();
      const queryKey = (app: string, id: string) => `${app}#${id}`;
      return Library.of({
        listQueries: (app) =>
          Effect.sync(() =>
            [...queries.values()].filter((q) => q.app === app).toSorted((a, b) => a.id.localeCompare(b.id)),
          ),
        getQuery: (app, id) => Effect.sync(() => Option.fromNullishOr(queries.get(queryKey(app, id)))),
        putQuery: (query) =>
          Effect.sync(() => {
            queries.set(queryKey(query.app, query.id), query);
          }),
        deleteQuery: (app, id) =>
          Effect.sync(() => {
            queries.delete(queryKey(app, id));
          }),
        listDashboards: (app) =>
          Effect.sync(() =>
            [...dashboards.values()]
              .filter((d) => app === undefined || d.app === undefined || d.app === app)
              .map((d) => ({ d, key: `${d.app ?? CROSS_APP}#${d.id}` }))
              // As DynamoDB sorts keys: by code unit, so `~` (cross-app) comes last.
              .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
              .map(({ d }) => d),
          ),
        getDashboard: (id) => Effect.sync(() => Option.fromNullishOr(dashboards.get(id))),
        putDashboard: (dashboard) =>
          Effect.sync(() => {
            dashboards.set(dashboard.id, dashboard);
          }),
        deleteDashboard: (id) =>
          Effect.sync(() => {
            dashboards.delete(id);
          }),
        removeApp: (app) =>
          Effect.sync(() => {
            for (const [k, q] of queries) if (q.app === app) queries.delete(k);
            for (const [k, d] of dashboards) if (d.app === app) dashboards.delete(k);
          }),
      });
    });
}
