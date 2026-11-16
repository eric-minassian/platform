import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { newTraceId, TelemetryEvent, TRACE_SAMPLE_RATE, traceSampled } from '../src/index.ts';

describe('trace sampling', () => {
  it('samples about TRACE_SAMPLE_RATE of trace ids', () => {
    const n = 40_000;
    let sampled = 0;
    for (let i = 0; i < n; i++) if (traceSampled(newTraceId())) sampled++;
    // Within 5 standard deviations of the binomial's mean (4.5% to 5.5%): a flake about once in 1.7M runs.
    const sd = Math.sqrt(n * TRACE_SAMPLE_RATE * (1 - TRACE_SAMPLE_RATE));
    expect(Math.abs(sampled - n * TRACE_SAMPLE_RATE)).toBeLessThan(5 * sd);
  });

  it('decides from the trace id alone, for any string a client sends', () => {
    const trace = newTraceId();
    expect(new Set(Array.from({ length: 5 }, () => traceSampled(trace))).size).toBe(1);
    expect(traceSampled('00000000000000000000000000000080')).toBe(true);
    expect(traceSampled('0123456789abcdef0123456789abcdef')).toBe(false);
    expect(typeof traceSampled('not a hex id ✓')).toBe('boolean');
    expect(typeof traceSampled('')).toBe('boolean');
  });
});

describe('telemetry lines', () => {
  const decode = Schema.decodeUnknownSync(TelemetryEvent);
  const base = { _p: 1, ts: 1, app: 'todo', stage: 'prod', rev: 'd1', trace: 't' };

  it('read a request without its path and with the spans it counted', () => {
    const line = {
      ...base,
      t: 'req',
      method: 'GET',
      route: '/api/todos',
      status: 200,
      dur: 4,
      calls: 3,
      callMs: 12,
    };
    expect(decode(line)).toEqual(line);
  });

  it('read a job without its attempt and with the spans it counted', () => {
    const line = {
      ...base,
      t: 'job',
      kind: 'queue',
      name: 'emails',
      status: 'ok',
      dur: 4,
      calls: 1,
      callMs: 2,
    };
    expect(decode(line)).toEqual(line);
  });
});
