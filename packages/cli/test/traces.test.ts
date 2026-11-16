import type { TelemetryEvent } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { formatTrace } from '../src/commands/observe.ts';

// oxlint-disable-next-line eslint/no-control-regex -- stripping ANSI colors
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const base = { _p: 1 as const, app: 'todo', stage: 'prod', rev: 'd1', trace: 'abcdef0123456789' };
const req = (over: Partial<Extract<TelemetryEvent, { t: 'req' }>> = {}): TelemetryEvent => ({
  ...base,
  t: 'req',
  ts: 1_000,
  method: 'GET',
  route: '/api/todos',
  status: 200,
  dur: 42,
  ...over,
});

describe('plat traces', () => {
  it('shows the calls a request counted instead of recording them', () => {
    const job: TelemetryEvent = {
      ...base,
      t: 'job',
      ts: 1_250,
      kind: 'queue',
      name: 'emails',
      status: 'ok',
      dur: 1_250,
      calls: 1,
      callMs: 1_240,
    };
    expect(plain(formatTrace([req({ calls: 12, callMs: 34.4 }), job])).split('\n')).toEqual([
      '+    0ms GET    /api/todos 200 42ms abcdef01',
      '           12 calls, 34ms, not recorded',
      '+  250ms job queue:emails ok 1250ms abcdef01',
      '           1 call, 1.2s, not recorded',
      'calls are recorded for requests and jobs that fail or take 1s or longer, and for 1 in 20 traces',
    ]);
  });

  it('says only how many more there were when it recorded some', () => {
    const span: TelemetryEvent = {
      ...base,
      t: 'span',
      ts: 990,
      op: 'db.get',
      dur: 2,
      status: 'ok',
      span: 's2',
      parent: 's1',
    };
    const lines = plain(formatTrace([span, req({ status: 500, span: 's1', calls: 2, callMs: 3 })])).split(
      '\n',
    );
    expect(lines.slice(1, 3)).toEqual([
      '+   10ms GET    /api/todos 500 42ms abcdef01',
      '           2 more calls, 3ms, not recorded',
    ]);
  });

  it('prints the path when it isn’t the route, and no note when nothing was counted', () => {
    expect(plain(formatTrace([req({ route: '/api/todos/:id', path: '/api/todos/42' })]))).toBe(
      '+    0ms GET    /api/todos/42 200 42ms abcdef01',
    );
  });
});
