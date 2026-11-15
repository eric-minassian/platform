/**
 * Control plane worker: the deployer, stage destroyer, scheduled jobs, and the
 * telemetry processor (target of the account-level log subscription).
 */
import { log } from '@eric-minassian/platform';
import { defineWorker } from '@eric-minassian/platform/worker';
import { rollback, runDeployment, runDestroy } from './deploy.ts';
import { runCostCollector } from './jobs/cost.ts';
import { runPinger } from './jobs/pinger.ts';
import { runReaper } from './jobs/reaper.ts';
import { runWatchdog } from './jobs/watchdog.ts';
import { aggregate, parseLogMessage } from './telemetry/aggregate.ts';
import { applyAggregation } from './telemetry/write.ts';

export default defineWorker({
  invoke: {
    deploy: async (payload: { id: string }) => runDeployment(payload.id),
    destroy: async (payload: { app: string; stage: string }) => runDestroy(payload.app, payload.stage),
    // Called synchronously by the API (see jobs/call.ts for why it runs here).
    rollback: async (payload: { app: string; stage: string; deploymentId?: string }) =>
      rollback(payload.app, payload.stage, payload.deploymentId),
  },
  crons: {
    pinger: () => runPinger(),
    watchdog: () => runWatchdog(),
    cost: () => runCostCollector(),
    reaper: () => runReaper(),
  },
  logs: async (batch) => {
    const events = [];
    for (const e of batch.logEvents) {
      const parsed = parseLogMessage(e.message);
      if (parsed) events.push(parsed);
    }
    if (events.length === 0) return;
    const { newGroups } = await applyAggregation(aggregate(events));
    if (newGroups.length) log.info('new error groups', { count: newGroups.length, logGroup: batch.logGroup });
  },
});
