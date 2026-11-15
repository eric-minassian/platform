import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCollections, parsePartition } from '../src/commands/observe.ts';
import { nextRun } from '../src/dev/crons.ts';
import { readDotEnv } from '../src/dev/local-stage.ts';
import { prettyLine } from '../src/dev/pretty.ts';
import { sparkline, table } from '../src/util/output.ts';
import { parseDuration, resolutionFor } from '../src/util/time.ts';
import { tempDir } from './helpers.ts';

describe('crons', () => {
  it('computes next runs in UTC', () => {
    const from = new Date('2026-11-14T10:07:30Z');
    expect(nextRun({ name: 'a', schedule: '*/5 * * * *' }, from).toISOString()).toBe(
      '2026-11-14T10:10:00.000Z',
    );
    expect(nextRun({ name: 'b', schedule: '0 3 * * *' }, from).toISOString()).toBe(
      '2026-11-15T03:00:00.000Z',
    );
    expect(nextRun({ name: 'c', schedule: 'rate(15 minutes)' }, from).toISOString()).toBe(
      '2026-11-14T10:22:30.000Z',
    );
  });
});

describe('time and output helpers', () => {
  it('parses durations and picks resolutions', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('6h')).toBe(21_600_000);
    expect(() => parseDuration('soon')).toThrow(/invalid duration/);
    expect(resolutionFor(parseDuration('1h'))).toBe('1m');
    expect(resolutionFor(parseDuration('7d'))).toBe('1h');
    expect(resolutionFor(parseDuration('30d'))).toBe('1d');
  });

  it('draws sparklines and tables', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
    expect(sparkline([null, 5, 5])).toBe(' ▄▄');
    expect(sparkline([])).toBe('');
    expect(table([{ a: 1, bb: 'x' }]).split('\n')[1]).toBe('1  x ');
  });

  it('encodes partition filters', () => {
    expect(parsePartition(['userId=u 1', 'kind=a=b'])).toBe('userId=u+1&kind=a%3Db');
    expect(() => parsePartition(['oops'])).toThrow(/key=value/);
  });

  it('tells a stage without a database from an empty one', () => {
    expect(formatCollections({ database: false, collections: [] }, 'pr-3')).toContain(
      'no database on pr-3; set db: true in plat.config.ts',
    );
    expect(formatCollections({ database: true, collections: [] }, 'prod')).toContain('no collections yet');
    expect(
      formatCollections(
        {
          database: true,
          collections: [
            { name: 'todos', sampled: 3 },
            { name: 'users', sampled: 1 },
          ],
        },
        'prod',
      ),
    ).toBe('todos\nusers');
  });
});

describe('dev helpers', () => {
  it('reads .env.local', () => {
    const p = join(tempDir(), '.env.local');
    writeFileSync(p, '# c\nSTRIPE_KEY="sk_test"\nexport OTHER=x\nbad line\n');
    expect(readDotEnv(p)).toEqual({ STRIPE_KEY: 'sk_test', OTHER: 'x' });
  });

  it('prettifies telemetry lines and hides Lambda noise', () => {
    const req = JSON.stringify({
      _p: 1,
      t: 'req',
      ts: 1,
      app: 'a',
      stage: 'local',
      rev: 'd',
      method: 'GET',
      route: '/api',
      path: '/api',
      status: 200,
      dur: 12.4,
    });
    expect(prettyLine(req)).toContain('/api');
    expect(prettyLine('START RequestId: 123 Version: $LATEST')).toBeNull();
    expect(prettyLine('plain text')).toBe('plain text');
    const lambdaPrefixed = `2026-11-14T00:00:00Z\tabc\tINFO\t${JSON.stringify({ _p: 1, t: 'log', ts: 1, app: 'a', stage: 's', rev: 'd', level: 'info', msg: 'hi' })}`;
    expect(prettyLine(lambdaPrefixed)).toContain('hi');
  });
});
