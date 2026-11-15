/** Queue depths, dead-letter redrive and "run cron now" for an app stage. */
import { GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand, StartMessageMoveTaskCommand } from '@aws-sdk/client-sqs';
import { names, type QueueStats } from '@ericminassian/platform-core';
import { Clock, Context, Effect, Layer, Option } from 'effect';
import { Aws, type AwsError, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';

export class AppQueues extends Context.Service<
  AppQueues,
  {
    /** Depth, in-flight, dead-lettered and oldest-message age of each named queue. */
    stats(
      app: string,
      stage: string,
      queueNames: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<QueueStats>>;
    /** Moves dead-lettered messages back to their source queue; answers the move task's handle. */
    redrive(app: string, stage: string, queue: string): Effect.Effect<string, AwsError>;
    /** Fires a cron on the app's worker now (async), with the payload the scheduler sends. */
    runCron(app: string, stage: string, cron: string): Effect.Effect<void>;
  }
>()('@ericminassian/platform-control-plane/AppQueues') {
  static readonly layer: Layer.Layer<AppQueues, never, Aws | Settings> = Layer.effect(
    AppQueues,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const queueRef = Effect.fnUntraced(function* (name: string) {
        const { accountId, region } = yield* settings.runtime;
        return {
          url: `https://sqs.${region}.amazonaws.com/${accountId}/${name}`,
          arn: `arn:aws:sqs:${region}:${accountId}:${name}`,
        };
      });

      /** None when the queue can't be read (not created yet, or gone). */
      const depth = (url: string) =>
        tryAws(() =>
          aws.sqs().send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
            }),
          ),
        ).pipe(
          Effect.map((res) =>
            Option.some({
              visible: Number(res.Attributes?.ApproximateNumberOfMessages ?? 0),
              inFlight: Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
            }),
          ),
          Effect.orElseSucceed(() => Option.none<{ visible: number; inFlight: number }>()),
        );

      /**
       * Age of the oldest message per queue, from the `AWS/SQS` metric SQS
       * publishes for free (SQS has no queue attribute for it). One
       * GetMetricData call covers every queue; it costs $0.01 per 1,000
       * metrics and only runs when someone looks. Queues with no datapoint in
       * the last 15 minutes are left out.
       */
      const oldestAges = Effect.fnUntraced(function* (queueNames: ReadonlyArray<string>) {
        const ages = new Map<string, number>();
        if (queueNames.length === 0) return ages;
        const now = yield* Clock.currentTimeMillis;
        const res = yield* tryAws(() =>
          aws.cloudwatch().send(
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
          ),
        ).pipe(Effect.option);
        for (const r of Option.match(res, { onNone: () => [], onSome: (r) => r.MetricDataResults ?? [] })) {
          const name = queueNames[Number(r.Id?.slice(1))];
          const latest = r.Values?.[0];
          if (name !== undefined && latest !== undefined) ages.set(name, latest);
        }
        return ages;
      });

      const stats = Effect.fn('AppQueues.stats')(function* (
        app: string,
        stage: string,
        queueNames: ReadonlyArray<string>,
      ) {
        const [ages, rows] = yield* Effect.all(
          [
            oldestAges(queueNames.map((key) => names.queue(app, stage, key))),
            Effect.forEach(
              queueNames,
              Effect.fnUntraced(function* (key: string) {
                const main = yield* queueRef(names.queue(app, stage, key));
                const dlq = yield* queueRef(names.deadLetterQueue(app, stage, key));
                const [m, d] = yield* Effect.all([depth(main.url), depth(dlq.url)], {
                  concurrency: 'unbounded',
                });
                return { key, m, d };
              }),
              { concurrency: 'unbounded' },
            ),
          ],
          { concurrency: 'unbounded' },
        );
        return rows.map(
          ({ key, m, d }): QueueStats => ({
            name: key,
            visible: Option.match(m, { onNone: () => 0, onSome: (x) => x.visible }),
            inFlight: Option.match(m, { onNone: () => 0, onSome: (x) => x.inFlight }),
            deadLetter: Option.match(d, { onNone: () => 0, onSome: (x) => x.visible }),
            oldestAgeSeconds: ages.get(names.queue(app, stage, key)) ?? null,
          }),
        );
      });

      const redrive = Effect.fn('AppQueues.redrive')(function* (app: string, stage: string, queue: string) {
        const main = yield* queueRef(names.queue(app, stage, queue));
        const dlq = yield* queueRef(names.deadLetterQueue(app, stage, queue));
        const res = yield* tryAws(() =>
          aws.sqs().send(new StartMessageMoveTaskCommand({ SourceArn: dlq.arn, DestinationArn: main.arn })),
        );
        if (!res.TaskHandle)
          return yield* Effect.die(new Error('SQS started a message move task without a handle'));
        return res.TaskHandle;
      });

      const runCron = Effect.fn('AppQueues.runCron')(function* (app: string, stage: string, cron: string) {
        yield* tryAws(() =>
          aws.lambda().send(
            new InvokeCommand({
              FunctionName: names.workerFunction(app, stage),
              InvocationType: 'Event',
              Payload: new TextEncoder().encode(JSON.stringify({ __platform: 'cron', name: cron })),
            }),
          ),
        );
      }, Effect.orDie);

      return AppQueues.of({ stats, redrive, runCron });
    }),
  );
}
