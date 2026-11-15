/** Observability endpoints: metrics, routes, jobs, queues, errors, uptime, cost, logs, traces. */

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { JobStats, TraceResponse } from '@ericminassian/platform-core';
import { telemetryKeys } from '@ericminassian/platform-core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AuthEnv } from '../auth.ts';
import { aws } from '../aws.ts';
import { getRuntimeConfig } from '../config.ts';
import { badRequest } from '../errors.ts';
import { queueStats } from '../jobs/queues.ts';
import { getTrace, searchLogs, tailLogs } from '../logs.ts';
import {
  parseRange,
  readCost,
  readErrors,
  readJobs,
  readMetrics,
  readRoutes,
  readUptime,
} from '../telemetry/query.ts';
import { liveManifest, memberApp, stageParam } from './context.ts';

const rangeOf = (c: { req: { query(k: string): string | undefined } }) =>
  parseRange({
    from: c.req.query('from'),
    to: c.req.query('to'),
    range: c.req.query('range'),
    res: c.req.query('res'),
  });

export const observe = new Hono<AuthEnv>()
  .get('/:app/metrics', async (c) => {
    const { app } = await memberApp(c);
    return c.json(await readMetrics(app.name, stageParam(c), rangeOf(c)));
  })
  .get('/:app/routes', async (c) => {
    const { app } = await memberApp(c);
    return c.json(await readRoutes(app.name, stageParam(c), rangeOf(c)));
  })
  .get('/:app/jobs', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const m = await liveManifest(app.name, stage);
    const declared: { kind: JobStats['kind']; name: string }[] = m
      ? [
          ...Object.keys(m.queues).map((name) => ({ kind: 'queue' as const, name })),
          ...m.events.map((name) => ({ kind: 'event' as const, name })),
          ...Object.keys(m.crons).map((name) => ({ kind: 'cron' as const, name })),
        ]
      : [];
    return c.json({
      jobs: await readJobs(app.name, stage, rangeOf(c), declared),
      crons: m ? Object.entries(m.crons).map(([name, cron]) => ({ name, schedule: cron.schedule })) : [],
    });
  })
  .get('/:app/queues', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const m = await liveManifest(app.name, stage);
    return c.json(await queueStats(app.name, stage, m ? Object.keys(m.queues) : []));
  })
  .get('/:app/errors', async (c) => {
    const { app } = await memberApp(c);
    const status = c.req.query('status');
    const groups = await readErrors(app.name, stageParam(c));
    return c.json(status ? groups.filter((g) => g.status === status) : groups);
  })
  .patch('/:app/errors/:fp', async (c) => {
    const { app } = await memberApp(c);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    if (body.status !== 'open' && body.status !== 'resolved' && body.status !== 'ignored') {
      throw badRequest('status must be open, resolved or ignored');
    }
    const { telemetryTable } = await getRuntimeConfig();
    await aws.ddb().send(
      new UpdateCommand({
        TableName: telemetryTable,
        Key: { pk: telemetryKeys.errors(app.name, stageParam(c)), sk: c.req.param('fp') },
        UpdateExpression: 'SET #s = :s',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': body.status },
      }),
    );
    return c.json({ status: body.status });
  })
  .get('/:app/uptime', async (c) => {
    const { app } = await memberApp(c);
    return c.json(await readUptime(app.name, stageParam(c), rangeOf(c)));
  })
  .get('/:app/cost', async (c) => {
    const { app } = await memberApp(c);
    const days = Math.min(Number(c.req.query('days') ?? 35) || 35, 400);
    return c.json(await readCost(app.name, days));
  })
  .get('/:app/logs', async (c) => {
    const { app } = await memberApp(c);
    const range = rangeOf(c);
    const stream = c.req.query('stream');
    return c.json(
      await searchLogs({
        app: app.name,
        stage: stageParam(c),
        from: range.from,
        to: range.to,
        ...(c.req.query('q') ? { q: c.req.query('q')! } : {}),
        ...(stream === 'web' || stream === 'worker' ? { stream } : {}),
        ...(c.req.query('limit') ? { limit: Number(c.req.query('limit')) } : {}),
        ...(c.req.query('next') ? { nextToken: c.req.query('next')! } : {}),
      }),
    );
  })
  .get('/:app/logs/tail', async (c) => {
    const { app } = await memberApp(c);
    const stage = stageParam(c);
    const q = c.req.query('q');
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      // CloudFront drops idle origin connections; keep the stream warm.
      const ping = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 20_000);
      try {
        for await (const line of tailLogs({
          app: app.name,
          stage,
          signal: abort.signal,
          ...(q ? { q } : {}),
        })) {
          await stream.writeSSE({ event: 'line', data: JSON.stringify(line) });
        }
      } catch (err) {
        if (!abort.signal.aborted) await stream.writeSSE({ event: 'error', data: String(err) });
      } finally {
        clearInterval(ping);
      }
    });
  })
  .get('/:app/traces/:trace', async (c) => {
    const { app } = await memberApp(c);
    const range = parseRange({
      from: c.req.query('from'),
      to: c.req.query('to'),
      range: c.req.query('range') ?? '7d',
    });
    const trace = c.req.param('trace');
    let events: TraceResponse['events'];
    try {
      events = await getTrace({ app: app.name, stage: stageParam(c), trace, from: range.from, to: range.to });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    const res: TraceResponse = { trace, events };
    return c.json(res);
  });
