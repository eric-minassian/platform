/**
 * Control plane HTTP API (`/v1/*`) and console sign-in (`/auth/*`). The
 * console SPA itself is static (web/dist) and served by the router; the
 * platform runtime wrapper (`startServer`) adds health, telemetry and traces.
 */
import { log } from '@ericminassian/platform';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { admin } from './api/admin.ts';
import { apps } from './api/apps.ts';
import { deployments, stages } from './api/deployments.ts';
import { manage } from './api/manage.ts';
import { observe } from './api/observe.ts';
import { cliAuth, consoleAuth } from './api/session.ts';
import { type AuthEnv, requireAuth } from './auth.ts';
import { ApiError } from './errors.ts';

const v1 = new Hono<AuthEnv>()
  // Unauthenticated: exchange a GitHub token for a platform token.
  .route('/', cliAuth)
  .use('*', async (c, next) => {
    // `/auth/cli` was handled above; everything else needs a principal.
    if (c.req.path.endsWith('/auth/cli')) return next();
    return requireAuth(c, next);
  })
  .route('/apps', apps)
  .route('/apps', stages)
  .route('/apps', observe)
  .route('/apps', manage)
  .route('/deployments', deployments)
  .route('/admin', admin);

const app = new Hono()
  .route('/v1', v1)
  .route('/auth', consoleAuth)
  .notFound((c) =>
    c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404),
  );

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status);
  if (err instanceof HTTPException)
    return c.json({ error: { code: 'http', message: err.message } }, err.status);
  log.error('unhandled API error', { err, path: c.req.path });
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
});

export default app;
