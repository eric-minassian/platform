import { stripVTControlCharacters } from 'node:util';
import type { EmailStatsResponse } from '@ericminassian/platform-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api.ts';
import { formatEmailStats, formatSending, formatSuppressed } from '../src/commands/email.ts';
import { saveCredentials } from '../src/credentials.ts';
import { createProgram } from '../src/main.ts';
import { setJsonMode } from '../src/util/output.ts';
import { tempDir } from './helpers.ts';

/** Output without its colors. */
const plain = stripVTControlCharacters;

const stats: EmailStatsResponse = {
  app: 'shop',
  stage: 'prod',
  enabled: true,
  from: '"Shop" <shop@mail.platform.example.com>',
  sending: { status: 'enabled' },
  today: { sent: 12, limit: 200 },
  res: '1h',
  totals: { sends: 200, deliveries: 190, bounces: 6, complaints: 1 },
  points: [
    { ts: '2026-11-15T10:00:00.000Z', sends: 120, deliveries: 115, bounces: 4, complaints: 1 },
    { ts: '2026-11-15T11:00:00.000Z', sends: 80, deliveries: 75, bounces: 2, complaints: 0 },
  ],
};

describe('plat email output', () => {
  it('shows the sender, status, today against the limit, counts and rates', () => {
    const out = plain(formatEmailStats(stats, '7d'));
    expect(out).toContain('from       "Shop" <shop@mail.platform.example.com>');
    expect(out).toContain('sending    enabled');
    expect(out).toContain('today      12 / 200 recipients (UTC day)');
    expect(out).toMatch(/sent\s+200 {2}█▁/);
    expect(out).toMatch(/bounced\s+6/);
    expect(out).toContain('bounce rate 3.0% · complaint rate 0.50%');
  });

  it('says who paused sending and how to resume it', () => {
    const policy = formatSending(
      { status: 'paused', pausedBy: 'policy', cause: 'Bounce finding', since: '2026-11-15T10:00:00.000Z' },
      'pr-3',
    ).map(plain);
    expect(policy).toEqual([
      'PAUSED by the reputation policy since 2026-11-15 10:00:00Z',
      'Bounce finding',
      'run `plat email resume --stage pr-3` once the cause is fixed',
    ]);
    const aws = formatSending({ status: 'paused', pausedBy: 'aws' }, 'prod').map(plain);
    expect(aws[0]).toBe('PAUSED by AWS');
    expect(aws[1]).toMatch(/^only AWS Support can lift this pause/);
    const out = plain(
      formatEmailStats({ ...stats, sending: { status: 'paused', pausedBy: 'manual', cause: 'x' } }, '7d'),
    );
    expect(out).toContain('sending    PAUSED manually\n             x\n             run `plat email resume`');
  });

  it('tells a stage without email, or one not deployed yet', () => {
    expect(plain(formatEmailStats({ ...stats, enabled: false, stage: 'pr-3', from: undefined }, '7d'))).toBe(
      '(no email on pr-3; set email: true in plat.config.ts and deploy)',
    );
    expect(plain(formatEmailStats({ ...stats, sending: undefined }, '7d'))).toContain(
      'sending    not deployed yet',
    );
  });

  it('lists suppressed addresses and how to page on', () => {
    const out = plain(
      formatSuppressed(
        {
          items: [{ address: 'a@x.com', reason: 'bounce', since: '2026-11-14T00:00:00.000Z' }],
          next: 'tok',
        },
        'prod',
      ),
    );
    expect(out.split('\n')).toEqual([
      'address  reason  since               ',
      'a@x.com  bounce  2026-11-14 00:00:00Z',
      'more: --next tok',
    ]);
    expect(plain(formatSuppressed({ items: [] }, 'pr-3'))).toBe('(no suppressed addresses on pr-3)');
  });
});

describe('plat email requests', () => {
  it('calls the email endpoints', async () => {
    const calls: string[] = [];
    const api = new ApiClient({
      baseUrl: 'https://api.test',
      token: 't',
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url}${init?.body ? ` ${init.body}` : ''}`);
        return new Response(init?.method === 'DELETE' ? null : '{}', {
          status: init?.method === 'DELETE' ? 204 : 200,
        });
      }) as unknown as typeof fetch,
    });
    await api.email('shop', { stage: 'prod', from: 1, to: 2, res: '1h' });
    await api.suppressed('shop', { stage: 'pr-3', next: 'tok' });
    await api.unsuppress('shop', 'a+b@x.com', { stage: 'prod' });
    await api.resumeEmail('shop', { stage: 'prod' });
    expect(calls).toEqual([
      'GET https://api.test/v1/apps/shop/email?stage=prod&from=1&to=2&res=1h',
      'GET https://api.test/v1/apps/shop/email/suppressed?stage=pr-3&next=tok',
      'DELETE https://api.test/v1/apps/shop/email/suppressed/a%2Bb%40x.com?stage=prod',
      'POST https://api.test/v1/apps/shop/email/resume?stage=prod',
    ]);
  });

  describe('options', () => {
    const urls: string[] = [];
    let out = '';
    beforeEach(() => {
      urls.length = 0;
      out = '';
      const dir = tempDir();
      vi.stubEnv('PLAT_CONFIG_DIR', dir);
      // In CI the client would otherwise sign in with the workflow's OIDC token.
      vi.stubEnv('GITHUB_ACTIONS', '');
      saveCredentials({
        apiUrl: 'https://api.test',
        token: 't',
        github: 'bob',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      vi.stubGlobal('fetch', async (url: string) => {
        urls.push(url);
        const path = new URL(url).pathname;
        return new Response(JSON.stringify(path.endsWith('/email') ? stats : { items: [] }));
      });
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        out += String(chunk);
        return true;
      });
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      setJsonMode(false);
    });
    const run = (...args: string[]) =>
      createProgram().parseAsync(['node', 'plat', ...args, '--app', 'shop', '--api-url', 'https://api.test']);

    it('runs the status by default, and gives each subcommand its own --stage', async () => {
      await run('email', '--stage', 'pr-3', '--since', '30d', '--json');
      await run('email', 'suppressed', '--stage', 'pr-4', '--next', 'tok');
      const [status, suppressed] = urls.map((u) => new URL(u));
      expect(status?.pathname).toBe('/v1/apps/shop/email');
      expect(status?.searchParams.get('stage')).toBe('pr-3');
      expect(status?.searchParams.get('res')).toBe('1d');
      expect(suppressed?.pathname).toBe('/v1/apps/shop/email/suppressed');
      expect(suppressed?.search).toBe('?stage=pr-4&next=tok');
      expect(JSON.parse(out.slice(0, out.indexOf('\n}') + 2))).toEqual(stats);
      expect(plain(out)).toContain('(no suppressed addresses on pr-4)');
    });
  });
});
