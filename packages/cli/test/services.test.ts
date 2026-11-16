import { join } from 'node:path';
import {
  type LogLine,
  parseManifest,
  type ResolvedManifest,
  type ServiceInfo,
  type ServicesResponse,
} from '@ericminassian/platform-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatLogLine, logStream } from '../src/commands/observe.ts';
import { formatServiceAction, formatServices } from '../src/commands/services.ts';
import { saveCredentials } from '../src/credentials.ts';
import { formatServiceCost, serviceCosts } from '../src/deploy.ts';
import { formatEvent } from '../src/dev/pretty.ts';
import { restartBackoff, serviceOutput } from '../src/dev/services.ts';
import { createProgram } from '../src/main.ts';
import { tempDir } from './helpers.ts';

// oxlint-disable-next-line eslint/no-control-regex -- stripping ANSI colors
const plain = (s: string | null) => (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

const ais: ServiceInfo = {
  name: 'ais',
  cpu: 0.25,
  memoryMb: 512,
  spot: true,
  state: 'running',
  desired: 1,
  running: 1,
  pending: 0,
  deployment: 'd-20261116-abc',
  startedAt: '2026-11-16T09:00:00.000Z',
  events: [],
  starts: 1,
  failedRuns: 0,
  points: [],
  monthly: { computeUsd: 2.21, publicIpv4Usd: 3.65, totalUsd: 5.86 },
};

describe('plat services output', () => {
  it('tables each service with its state, size and monthly estimate', () => {
    const lightning: ServiceInfo = {
      ...ais,
      name: 'lightning',
      cpu: 0.5,
      memoryMb: 1024,
      spot: false,
      state: 'failing',
      running: 0,
      pending: 1,
      startedAt: undefined,
      stopsAt: '2026-11-16T10:00:00.000Z',
      lastStop: { at: '2026-11-16T09:58:00.000Z', reason: 'Essential container in task exited', exitCode: 1 },
      starts: 4,
      failedRuns: 2,
      monthly: { computeUsd: 14.42, publicIpv4Usd: 3.65, totalUsd: 18.07 },
    };
    const out = plain(formatServices({ app: 'atlas', stage: 'prod', res: '1h', services: [ais, lightning] }));
    const [header, first, second, , ...notes] = out.split('\n');
    expect(header!.trim().split(/\s{2,}/)).toEqual([
      'name',
      'state',
      'running/desired',
      'size',
      'deployment',
      'started',
      'stops at',
      '≈ monthly',
    ]);
    expect(first!.trim().split(/\s{2,}/)).toEqual([
      'ais',
      'running',
      '1/1',
      '0.25 vCPU · 512 MB · Spot',
      'd-20261116-abc',
      '2026-11-16 09:00:00Z',
      '-',
      '$5.86',
    ]);
    expect(second).toContain('0.5 vCPU · 1024 MB · on-demand');
    expect(second).toContain('2026-11-16 10:00:00Z');
    expect(notes).toEqual([
      'lightning: last stopped 2026-11-16 09:58:00Z: Essential container in task exited (exit 1)',
      'lightning: 4 container starts, 2 failed runs in range',
    ]);
  });

  it('says when a stage has no services', () => {
    expect(plain(formatServices({ app: 'atlas', stage: 'pr-3', res: '1m', services: [] }))).toBe(
      '(no services on pr-3)',
    );
  });

  it('confirms each action', () => {
    expect(plain(formatServiceAction({ name: 'ais', desired: 1 }, 'prod', 'restart'))).toBe(
      '✓ restarting ais on prod',
    );
    expect(
      plain(
        formatServiceAction(
          { name: 'ais', desired: 1, stopsAt: '2026-11-16T10:30:00.000Z' },
          'pr-3',
          'start',
        ),
      ),
    ).toBe('✓ starting ais on pr-3; it stops at 2026-11-16 10:30:00Z');
    expect(plain(formatServiceAction({ name: 'ais', desired: 0 }, 'prod', 'stop'))).toBe(
      '✓ stopping ais on prod until it is started again or the stage is redeployed',
    );
  });
});

describe('plat services commands', () => {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let stdout: string;

  beforeEach(() => {
    calls.length = 0;
    stdout = '';
    vi.stubEnv('PLAT_CONFIG_DIR', join(tempDir(), 'plat'));
    vi.stubEnv('PLATFORM_API_URL', 'https://api.test');
    vi.stubEnv('GITHUB_ACTIONS', '');
    saveCredentials({
      apiUrl: 'https://api.test',
      token: 't',
      github: 'octo',
      expiresAt: '2999-01-01T00:00:00Z',
    });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const sent = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, ...(sent === undefined ? {} : { body: sent }) });
      const body =
        method === 'GET'
          ? ({ app: 'atlas', stage: 'pr-3', res: '1m', services: [ais] } satisfies ServicesResponse)
          : { name: 'ais', desired: 1, stopsAt: '2026-11-16T10:30:00.000Z' };
      return new Response(JSON.stringify(body), { status: method === 'GET' ? 200 : 202 });
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  const plat = (...args: string[]) => createProgram().parseAsync(['node', 'plat', ...args, '--app', 'atlas']);

  it('lists a stage’s services over the requested range', async () => {
    await plat('services', '--stage', 'pr-3', '--since', '6h', '--json');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/apps/atlas/services');
    expect(url.searchParams.get('stage')).toBe('pr-3');
    expect(url.searchParams.get('res')).toBe('1m');
    expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(6 * 3_600_000);
    expect(JSON.parse(stdout)).toMatchObject({
      stage: 'pr-3',
      services: [{ name: 'ais', state: 'running' }],
    });
  });

  it('starts, stops and restarts a service, whichever side of the name the options are on', async () => {
    await plat('services', 'start', 'ais', '--stage', 'pr-3', '--minutes', '45', '--json');
    await plat('services', '--stage', 'pr-3', 'stop', 'ais');
    await plat('services', 'restart', 'ais');
    expect(calls).toEqual([
      {
        method: 'POST',
        url: 'https://api.test/v1/apps/atlas/services/ais/start?stage=pr-3',
        body: { minutes: 45 },
      },
      { method: 'POST', url: 'https://api.test/v1/apps/atlas/services/ais/stop?stage=pr-3', body: {} },
      { method: 'POST', url: 'https://api.test/v1/apps/atlas/services/ais/restart?stage=prod', body: {} },
    ]);
    const [json, ...rest] = stdout.split('\n}\n');
    expect(JSON.parse(`${json}\n}`)).toEqual({
      stage: 'pr-3',
      action: 'start',
      name: 'ais',
      desired: 1,
      stopsAt: '2026-11-16T10:30:00.000Z',
    });
    expect(plain(rest.join(''))).toContain('✓ stopping ais on pr-3');
    expect(plain(rest.join(''))).toContain('✓ restarting ais on prod; it stops at 2026-11-16 10:30:00Z');
  });

  it('refuses minutes outside 1-1440 before calling the API', async () => {
    await plat('services', 'start', 'ais', '--minutes', '0', '--json');
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(2);
    const { error } = JSON.parse(stdout) as { error: { message: string } };
    expect(error.message).toMatch(/--minutes must be a whole number from 1 to 1440/);
  });

  it('filters logs to one service', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push({ method: 'GET', url });
      return new Response(JSON.stringify({ lines: [] }));
    });
    await plat('logs', '--stream', 'ais', '--json');
    expect(new URL(calls[0]!.url).searchParams.get('stream')).toBe('service:ais');
  });
});

describe('plat logs streams', () => {
  it('maps --stream to the API’s streams', () => {
    expect(logStream('web')).toBe('web');
    expect(logStream('worker')).toBe('worker');
    expect(logStream('ais')).toBe('service:ais');
    expect(logStream('service:worker')).toBe('service:worker');
    expect(() => logStream('Not A Name')).toThrow(/web, worker or a service name/);
  });

  it('labels service lines with the service’s name', () => {
    const line = (stream: string): LogLine => ({ ts: '2026-11-16T09:00:00.000Z', stream, message: 'hi' });
    expect(plain(formatLogLine(line('service:ais')))).toBe('2026-11-16 09:00:00Z ais    hi');
    expect(plain(formatLogLine(line('service:lightning')))).toBe('2026-11-16 09:00:00Z lightning hi');
    expect(plain(formatLogLine(line('worker')))).toBe('2026-11-16 09:00:00Z worker hi');
  });

  it('formats service starts, stops and runs', () => {
    const base = { _p: 1 as const, ts: 0, app: 'atlas', stage: 'prod', rev: 'd1' };
    expect(
      plain(
        formatEvent({ ...base, t: 'env', event: 'start', runtime: 'service', name: 'ais', initMs: 412.4 }),
      ),
    ).toBe('service ais start (412ms init)');
    expect(
      plain(
        formatEvent({ ...base, t: 'env', event: 'stop', runtime: 'service', name: 'ais', reason: 'SIGTERM' }),
      ),
    ).toBe('service ais stop (SIGTERM)');
    expect(plain(formatEvent({ ...base, t: 'env', event: 'start', runtime: 'web', initMs: 90 }))).toBe(
      'web environment start (90ms init)',
    );
    expect(
      plain(
        formatEvent({ ...base, t: 'job', kind: 'service', name: 'ais', status: 'error', dur: 7_200_000 }),
      ),
    ).toBe('service ais run failed after 2h 00m');
    expect(
      plain(formatEvent({ ...base, t: 'job', kind: 'service', name: 'ais/batch', status: 'ok', dur: 31 })),
    ).toBe('job service:ais/batch ok 31ms');
  });
});

describe('plat deploy service costs', () => {
  const manifest = (services: object): ResolvedManifest => parseManifest({ name: 'atlas', services });

  it('estimates each service as if it ran all month', () => {
    const m = manifest({
      ais: { entry: 'src/ais.ts' },
      lightning: { entry: 'src/lightning.ts', cpu: 0.5, memoryMb: 1024, spot: false, previewMinutes: 0 },
    });
    const prod = serviceCosts(m, 'prod');
    expect(prod).toEqual([
      {
        name: 'ais',
        cpu: 0.25,
        memoryMb: 512,
        spot: true,
        size: '0.25 vCPU · 512 MB · Spot',
        monthly: { computeUsd: 2.21, publicIpv4Usd: 3.65, totalUsd: 5.86 },
      },
      expect.objectContaining({ name: 'lightning', size: '0.5 vCPU · 1024 MB · on-demand' }),
    ]);
    expect(formatServiceCost(prod[0]!, 'prod')).toBe(
      'service ais (0.25 vCPU · 512 MB · Spot) ≈ $5.86/month while running',
    );

    const [preview, stopped] = serviceCosts(m, 'pr-3');
    expect(formatServiceCost(preview!, 'pr-3')).toBe(
      'service ais (0.25 vCPU · 512 MB · Spot) ≈ $5.86/month while running; previews run it 30 min after each deploy',
    );
    expect(formatServiceCost(stopped!, 'pr-3')).toMatch(
      /; previews run it only after `plat services start lightning --stage pr-3`$/,
    );
  });
});

describe('plat dev service restarts', () => {
  it('backs off from 1 s to 30 s, and starts over after a minute up or an edit', () => {
    const b = restartBackoff();
    const waits: number[] = [];
    let now = 0;
    for (let i = 0; i < 7; i++) {
      b.started(now, i > 0);
      now += 100;
      waits.push(b.exited(now));
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    b.started(now, true);
    now += 60_000;
    expect(b.exited(now)).toBe(1_000);
    b.started(now, true);
    expect(b.exited(now + 10)).toBe(2_000);
    b.started(now, false);
    expect(b.exited(now + 10)).toBe(1_000);
  });

  it('takes the host’s start and exit lines out of the service’s output', () => {
    const seen: string[] = [];
    const feed = serviceOutput('tok', {
      line: (l) => seen.push(`line ${l}`),
      started: () => seen.push('started'),
      exited: (code) => seen.push(`exited ${code}`),
    });
    feed('tok start\nhello');
    feed(' world\ntok exit 1\ntok exited\n');
    expect(seen).toEqual(['started', 'line hello world', 'exited 1', 'line tok exited']);
  });
});
