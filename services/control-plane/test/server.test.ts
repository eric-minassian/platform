import { describe, expect, it } from 'vitest';
import app from '../src/server.ts';

describe('API surface', () => {
  it('rejects unauthenticated requests with a JSON error', async () => {
    const res = await app.fetch(new Request('https://platform.test/v1/apps'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('validates the CLI login body before calling GitHub', async () => {
    const res = await app.fetch(
      new Request('https://platform.test/v1/auth/cli', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects malformed bearer tokens', async () => {
    const res = await app.fetch(
      new Request('https://platform.test/v1/me', { headers: { authorization: 'Bearer nope' } }),
    );
    expect(res.status).toBe(401);
  });

  it('returns JSON 404s for unknown routes', async () => {
    const res = await app.fetch(new Request('https://platform.test/v2/whatever'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
