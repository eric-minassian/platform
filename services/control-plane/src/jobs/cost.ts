/**
 * Daily cost collector: Cost Explorer grouped by the `platform:app` cost
 * allocation tag, last 35 days, written as `cost#<app>` / `YYYY-MM-DD` items.
 * Untagged spend (the platform's shared resources) is recorded as `_platform`,
 * and the account total as `_total`. One Cost Explorer call ≈ $0.01.
 */
import { GetCostAndUsageCommand, type ResultByTime } from '@aws-sdk/client-cost-explorer';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { TAGS } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer } from 'effect';
import { Aws, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';
import { costKey } from '../telemetry/query.ts';

export const PLATFORM_COST_KEY = '_platform';
export const TOTAL_COST_KEY = '_total';

/** `{ app → { date → usd } }` from Cost Explorer results (pure). */
export function parseCostResults(results: readonly ResultByTime[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const add = (app: string, date: string, usd: number) => {
    const m = out.get(app) ?? new Map<string, number>();
    out.set(app, m);
    m.set(date, (m.get(date) ?? 0) + usd);
  };
  for (const r of results) {
    const date = r.TimePeriod?.Start;
    if (!date) continue;
    for (const g of r.Groups ?? []) {
      const key = g.Keys?.[0] ?? '';
      // Tag group keys look like `platform:app$foo`; an empty value means untagged.
      const value = key.includes('$') ? key.slice(key.indexOf('$') + 1) : key;
      const usd = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      add(value || PLATFORM_COST_KEY, date, usd);
      add(TOTAL_COST_KEY, date, usd);
    }
  }
  return out;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class CostCollector extends Context.Service<
  CostCollector,
  {
    /** Pulls the last `days` days (default 35) and answers how many cost keys were written. */
    run(days?: number): Effect.Effect<{ readonly apps: number }>;
  }
>()('@ericminassian/platform-control-plane/CostCollector') {
  static readonly layer: Layer.Layer<CostCollector, never, Aws | Settings> = Layer.effect(
    CostCollector,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const run = Effect.fn('CostCollector.run')(function* (days = 35) {
        const { telemetryTable } = yield* settings.runtime;
        const now = yield* Clock.currentTimeMillis;
        const results: ResultByTime[] = [];
        let NextPageToken: string | undefined;
        do {
          const res = yield* tryAws(() =>
            aws.ce().send(
              new GetCostAndUsageCommand({
                TimePeriod: { Start: day(now - days * 86_400_000), End: day(now) },
                Granularity: 'DAILY',
                Metrics: ['UnblendedCost'],
                GroupBy: [{ Type: 'TAG', Key: TAGS.app }],
                NextPageToken,
              }),
            ),
          );
          results.push(...(res.ResultsByTime ?? []));
          NextPageToken = res.NextPageToken;
        } while (NextPageToken);

        const parsed = parseCostResults(results);
        const items = [...parsed].flatMap(([app, byDate]) =>
          [...byDate].map(([date, usd]) => ({ app, date, usd })),
        );
        yield* Effect.forEach(
          items,
          ({ app, date, usd }) =>
            tryAws(() =>
              aws.ddb().send(
                new PutCommand({
                  TableName: telemetryTable,
                  Item: {
                    pk: costKey(app),
                    sk: date,
                    usd: Math.round(usd * 10_000) / 10_000,
                    ttl: Math.floor(Date.parse(date) / 1000) + 400 * 86_400,
                  },
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        );
        return { apps: parsed.size };
      }, Effect.orDie);

      return CostCollector.of({ run });
    }),
  );
}
