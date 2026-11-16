/**
 * Rate-limit scenarios run against the in-memory counters (rate-limit.test.ts)
 * and DynamoDB in the AWS Emulator (integration/emulator.test.ts), so the two
 * count the same. Windows are 30 days long, so a run on the real clock never
 * crosses one.
 */
import { Duration, Effect } from 'effect';
import { expect } from 'vitest';
import { RateLimits } from '../src/index.ts';

export const rateLimitContract = (prefix: string) =>
  Effect.gen(function* () {
    const limits = yield* RateLimits;
    const per = '30 days';

    // Racing checks: exactly `max` fit, each told the count its own write left.
    const race = yield* Effect.all(
      Array.from({ length: 64 }, () => limits.check(`${prefix}-race`, { key: 'k', max: 10, per })),
      { concurrency: 'unbounded' },
    );
    const fit = race.filter((r) => r.ok);
    expect(fit).toHaveLength(10);
    expect(fit.map((r) => r.remaining).toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const r of race.filter((x) => !x.ok)) {
      expect(r.remaining).toBe(0);
      expect(Duration.toMillis(r.retryAfter)).toBeGreaterThan(0);
    }

    // Costs: a use that doesn't fit isn't counted, so a smaller one still can.
    const take = (cost: number) => limits.check(`${prefix}-cost`, { key: 'k', max: 100, per, cost });
    expect(yield* take(60)).toMatchObject({ ok: true, remaining: 40 });
    expect(yield* take(60)).toMatchObject({ ok: false, remaining: 40 });
    expect(yield* take(40)).toMatchObject({ ok: true, remaining: 0 });
    expect((yield* take(1)).ok).toBe(false);

    // Another key has its own count.
    expect(yield* limits.check(`${prefix}-cost`, { key: 'other', max: 100, per, cost: 100 })).toMatchObject({
      ok: true,
      remaining: 0,
    });
  });
