import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AppConfig, parseManifest } from '@ericminassian/platform-core';
import { describe, expect, it } from 'vitest';
import { edgeChecksFor, hasEdgeChecks, waitForEdge } from '../src/edge.ts';
import { tempDir } from './helpers.ts';

const INDEX = '<!doctype html><script type="module" src="/assets/index-new.js"></script>';

function checksFor(web: NonNullable<AppConfig['web']>, opts: { index?: boolean; hasStatic?: boolean } = {}) {
  const root = tempDir();
  if (opts.index !== false) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.html'), INDEX);
  }
  return edgeChecksFor({
    root,
    manifest: parseManifest({ name: 'shop', web }),
    stage: 'prod',
    deploymentId: 'd-new',
    hasStatic: opts.hasStatic ?? !!web.static,
  });
}

describe('edgeChecksFor', () => {
  it('checks the server revision and the built index.html', () => {
    const c = checksFor({ server: 'src/server.ts', static: 'dist' });
    expect(c.health).toBe(true);
    expect(c.indexHtml?.toString()).toBe(INDEX);
  });

  it('checks only index.html for a static site, which has no health endpoint', () => {
    const c = checksFor({ static: 'dist' });
    expect(c).toEqual({ health: false, indexHtml: Buffer.from(INDEX) });
  });

  it('checks only the revision for a server-only app', () => {
    expect(checksFor({ server: 'src/server.ts' }, { index: false })).toEqual({ health: true });
  });

  it('skips index.html when the server routes claim it', () => {
    expect(checksFor({ server: 'src/server.ts', static: 'dist', serverRoutes: ['/'] })).toEqual({
      health: true,
    });
  });

  it('has nothing to check for a static site without index.html', () => {
    const c = checksFor({ static: 'dist', spa: false }, { index: false });
    expect(hasEdgeChecks(c)).toBe(false);
  });
});

/** Builds a fresh answer per request: a Response body can only be read once. */
type Answer = () => Response | Error;

/** Serves each path's answers in order, repeating the last one. */
function edge(answers: Record<string, Answer[]>, calls: string[] = []) {
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const list = answers[path] ?? [];
    const a = (list.length > 1 ? list.shift() : list[0])?.();
    if (!a) return new Response('Nothing is deployed here.', { status: 404 });
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
}

const health = (revision: string) => () => Response.json({ ok: true, app: 'shop', stage: 'prod', revision });
function page(body: string, status = 200): Answer {
  return () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

describe('waitForEdge', () => {
  const checks = { health: true, indexHtml: Buffer.from(INDEX) };

  it('waits until both the revision and index.html are the new deployment', async () => {
    const calls: string[] = [];
    const fetch = edge(
      {
        '/__platform/health': [
          () => new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND shop.example.com') }),
          health('d-old'),
          health('d-new'),
        ],
        '/index.html': [page('old'), page('old'), page('old'), page(INDEX)],
      },
      calls,
    );
    const r = await waitForEdge('https://shop.example.com', 'd-new', checks, { fetch, intervalMs: 1 });
    expect(r).toMatchObject({ ok: true, pending: [] });
    // A check that passed is not repeated.
    expect(calls.filter((c) => c === '/__platform/health')).toHaveLength(3);
    expect(calls.filter((c) => c === '/index.html')).toHaveLength(4);
  });

  it('reports what each unconfirmed check saw last when it times out', async () => {
    const fetch = edge({
      '/__platform/health': [health('d-old')],
      '/index.html': [page('', 503)],
    });
    const r = await waitForEdge('https://shop.example.com/', 'd-new', checks, {
      fetch,
      timeoutMs: 20,
      intervalMs: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.pending).toEqual(['/__platform/health → revision d-old', '/index.html → HTTP 503']);
  });

  it('treats a changed index.html as not yet served', async () => {
    const fetch = edge({ '/index.html': [page(`${INDEX}\n`)] });
    const r = await waitForEdge(
      'https://shop.example.com',
      'd-new',
      { health: false, indexHtml: Buffer.from(INDEX) },
      { fetch, timeoutMs: 10, intervalMs: 5 },
    );
    expect(r.pending).toEqual(['/index.html → not this build']);
  });
});
