/**
 * Uptime pinger (every 5 minutes): hits `/__platform/health` on every active
 * prod stage, records the result, and alerts on up→down (after two failed
 * checks in a row) and down→up transitions.
 */
import { PublishCommand } from '@aws-sdk/client-sns';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { HEALTH_PATH, PROD_STAGE, telemetryKeys } from '@ericminassian/platform-core';
import { aws } from '../aws.ts';
import { consoleUrl, getRuntimeConfig } from '../config.ts';
import { listAllStages, type StageItem, updateStage } from '../store.ts';
import { pool } from '../util.ts';

const UPTIME_TTL_DAYS = 35;
const FAILURES_BEFORE_DOWN = 2;

export interface CheckResult {
  ok: boolean;
  status: number;
  ms: number;
}

export async function check(url: string, timeoutMs = 10_000): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${url}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });
    await res.body?.cancel();
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: Date.now() - started };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - started };
  }
}

/** Next up/down state for a stage given its stored state and a new result (pure). */
export function nextUptimeState(
  prev: { up?: boolean; failures?: number },
  ok: boolean,
): { up: boolean; failures: number; transition: 'down' | 'up' | null } {
  if (ok) return { up: true, failures: 0, transition: prev.up === false ? 'up' : null };
  const failures = (prev.failures ?? 0) + 1;
  const down = failures >= FAILURES_BEFORE_DOWN;
  const wasUp = prev.up !== false;
  return { up: !down && wasUp, failures, transition: down && wasUp ? 'down' : null };
}

export async function runPinger(): Promise<{ checked: number; down: string[] }> {
  const { telemetryTable, alertsTopicArn } = await getRuntimeConfig();
  const stages = (await listAllStages()).filter((s) => s.stage === PROD_STAGE && s.status === 'active');
  const down: string[] = [];
  await pool(stages, 8, async (s: StageItem) => {
    const result = await check(s.url);
    const ts = Date.now();
    await aws.ddb().send(
      new PutCommand({
        TableName: telemetryTable,
        Item: {
          pk: telemetryKeys.uptime(s.app, s.stage),
          sk: telemetryKeys.time(ts),
          ...result,
          ttl: Math.floor(ts / 1000) + UPTIME_TTL_DAYS * 86_400,
        },
      }),
    );
    const next = nextUptimeState(s, result.ok);
    if (!next.up) down.push(s.app);
    if (next.up !== s.up || next.failures !== (s.failures ?? 0)) {
      await updateStage(s.app, s.stage, {
        up: next.up,
        failures: next.failures,
        ...(next.transition ? { upChangedAt: new Date(ts).toISOString() } : {}),
      });
    }
    if (next.transition && alertsTopicArn) {
      const what = next.transition === 'down' ? 'DOWN' : 'back UP';
      await aws.sns().send(
        new PublishCommand({
          TopicArn: alertsTopicArn,
          Subject: `[platform] ${s.app} is ${what}`,
          Message: `${s.url}${HEALTH_PATH} → ${result.status || 'no response'} in ${result.ms}ms\n\n${consoleUrl()}/apps/${s.app}`,
        }),
      );
    }
  });
  return { checked: stages.length, down };
}
