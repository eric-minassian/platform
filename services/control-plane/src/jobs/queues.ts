/** Queue depths, dead-letter redrive and "run cron now" for an app stage. */
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand, StartMessageMoveTaskCommand } from '@aws-sdk/client-sqs';
import { names, type QueueStats } from '@eric-minassian/platform-core';
import { aws } from '../aws.ts';
import { getRuntimeConfig } from '../config.ts';

async function queueRef(name: string): Promise<{ url: string; arn: string }> {
  const { accountId, region } = await getRuntimeConfig();
  return {
    url: `https://sqs.${region}.amazonaws.com/${accountId}/${name}`,
    arn: `arn:aws:sqs:${region}:${accountId}:${name}`,
  };
}

async function depth(url: string): Promise<{ visible: number; inFlight: number } | null> {
  const res = await aws
    .sqs()
    .send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    )
    .catch(() => null);
  if (!res) return null;
  return {
    visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
  };
}

/**
 * Age of the oldest message per queue, from the `AWS/SQS` metric SQS publishes
 * for free (SQS has no queue attribute for it). One GetMetricData call covers
 * every queue; it costs $0.01 per 1,000 metrics and only runs when someone
 * looks. Returns null for queues with no datapoint in the last 15 minutes.
 */
export async function oldestAges(
  queueNames: readonly string[],
  now = Date.now(),
): Promise<Map<string, number>> {
  const ages = new Map<string, number>();
  if (queueNames.length === 0) return ages;
  const res = await aws
    .cloudwatch()
    .send(
      new GetMetricDataCommand({
        StartTime: new Date(now - 15 * 60_000),
        EndTime: new Date(now),
        ScanBy: 'TimestampDescending',
        MetricDataQueries: queueNames.map((name, i) => ({
          Id: `q${i}`,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/SQS',
              MetricName: 'ApproximateAgeOfOldestMessage',
              Dimensions: [{ Name: 'QueueName', Value: name }],
            },
            Period: 60,
            Stat: 'Maximum',
          },
        })),
      }),
    )
    .catch(() => null);
  for (const r of res?.MetricDataResults ?? []) {
    const i = Number(r.Id?.slice(1));
    const latest = r.Values?.[0];
    const name = queueNames[i];
    if (name !== undefined && latest !== undefined) ages.set(name, latest);
  }
  return ages;
}

export async function queueStats(
  app: string,
  stage: string,
  queueNames: readonly string[],
): Promise<QueueStats[]> {
  const mainNames = queueNames.map((key) => names.queue(app, stage, key));
  const [ages, rows] = await Promise.all([
    oldestAges(mainNames),
    Promise.all(
      queueNames.map(async (key) => {
        const [main, dlq] = await Promise.all([
          queueRef(names.queue(app, stage, key)),
          queueRef(names.deadLetterQueue(app, stage, key)),
        ]);
        const [m, d] = await Promise.all([depth(main.url), depth(dlq.url)]);
        return { key, m, d };
      }),
    ),
  ]);
  return rows.map(({ key, m, d }) => ({
    name: key,
    visible: m?.visible ?? 0,
    inFlight: m?.inFlight ?? 0,
    deadLetter: d?.visible ?? 0,
    oldestAgeSeconds: ages.get(names.queue(app, stage, key)) ?? null,
  }));
}

/** Moves dead-lettered messages back to their source queue. */
export async function redrive(app: string, stage: string, key: string): Promise<string | undefined> {
  const [main, dlq] = await Promise.all([
    queueRef(names.queue(app, stage, key)),
    queueRef(names.deadLetterQueue(app, stage, key)),
  ]);
  const res = await aws
    .sqs()
    .send(new StartMessageMoveTaskCommand({ SourceArn: dlq.arn, DestinationArn: main.arn }));
  return res.TaskHandle;
}

/** Fires a cron on the app's worker now (async), with the same payload the scheduler sends. */
export async function runCron(app: string, stage: string, cron: string): Promise<void> {
  await aws.lambda().send(
    new InvokeCommand({
      FunctionName: names.workerFunction(app, stage),
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({ __platform: 'cron', name: cron })),
    }),
  );
}
