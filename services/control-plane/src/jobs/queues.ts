/**
 * An app stage's jobs that aren't running: retries and delayed sends waiting
 * for their time (one-shot schedules), and dead letters (the stage's
 * dead-letter queue, which nothing polls). Redrive runs dead letters again from
 * their first attempt; discard deletes them. Also "run cron now".
 */
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { ListSchedulesCommand } from '@aws-sdk/client-scheduler';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import {
  DEAD_LETTERS_READ,
  type DeadLetterItem,
  type DeadLettersResponse,
  type DeadLetterView,
  handlerFunctionName,
  jobSchedulePrefix,
  names,
  type QueueStats,
  readDeadLetter,
  type ResolvedManifest,
} from '@ericminassian/platform-core';
import { Context, Effect, Layer, Option } from 'effect';
import { Aws, type AwsError, tryAws } from '../aws.ts';
import { Settings } from '../config.ts';

/** How much of a dead letter's payload the list shows. */
const PREVIEW_CHARS = 300;

/** A dead letter as read, with what acting on it needs. */
interface Letter {
  readonly message: Message;
  readonly view: DeadLetterView | null;
}

export class AppQueues extends Context.Service<
  AppQueues,
  {
    /** Each named queue's scheduled jobs and dead letters. */
    stats(
      app: string,
      stage: string,
      queueNames: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<QueueStats>>;
    /** The stage's dead letters: the queue's count, and up to `DEAD_LETTERS_READ` of them. */
    deadLetters(app: string, stage: string): Effect.Effect<DeadLettersResponse>;
    /**
     * Runs dead letters again (`ids`, or all of them) from their first attempt, on the function
     * their handler runs in now; answers how many. Letters whose handler is gone stay.
     */
    redrive(
      app: string,
      stage: string,
      manifest: ResolvedManifest,
      ids: ReadonlyArray<string> | undefined,
    ): Effect.Effect<number, AwsError>;
    /** Deletes dead letters (`ids`, or all of them); answers how many. */
    discard(
      app: string,
      stage: string,
      ids: ReadonlyArray<string> | undefined,
    ): Effect.Effect<number, AwsError>;
    /**
     * Fires a cron now (async): the payload the scheduler sends, to the function it sends it to
     * (the cron's own when it sets its memory, timeout or concurrency, else the worker's).
     */
    runCron(app: string, stage: string, manifest: ResolvedManifest, cron: string): Effect.Effect<void>;
  }
>()('@ericminassian/platform-control-plane/AppQueues') {
  static readonly layer: Layer.Layer<AppQueues, never, Aws | Settings> = Layer.effect(
    AppQueues,
    Effect.gen(function* () {
      const aws = yield* Aws;
      const settings = yield* Settings;

      const deadQueueUrl = Effect.fnUntraced(function* (app: string, stage: string) {
        const { accountId, region } = yield* settings.runtime;
        return `https://sqs.${region}.amazonaws.com/${accountId}/${names.deadLetters(app, stage)}`;
      });

      /** Messages in the queue; 0 when it doesn't exist (no worker, or not deployed yet). */
      const total = (url: string) =>
        tryAws(() =>
          aws.sqs().send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: ['ApproximateNumberOfMessages'],
            }),
          ),
        ).pipe(
          Effect.map((r) => Number(r.Attributes?.ApproximateNumberOfMessages ?? 0)),
          Effect.orElseSucceed(() => 0),
        );

      const receive = (url: string, visibility: number) =>
        tryAws(() =>
          aws.sqs().send(
            new ReceiveMessageCommand({
              QueueUrl: url,
              MaxNumberOfMessages: 10,
              VisibilityTimeout: visibility,
              MessageAttributeNames: ['All'],
            }),
          ),
        ).pipe(Effect.map((r) => r.Messages ?? []));

      const letter = (message: Message): Letter => ({
        message,
        view: readDeadLetter(message.Body ?? '', message.MessageAttributes ?? {}),
      });

      /**
       * Reads up to `max` dead letters without hiding them (visibility 0), so a look doesn't keep
       * them from a redrive. SQS returns a sample per call, so this reads until a call brings
       * nothing new.
       */
      const peek = Effect.fnUntraced(function* (url: string, max: number) {
        const seen = new Map<string, Letter>();
        while (seen.size < max) {
          const batch = yield* receive(url, 0).pipe(Effect.orElseSucceed(() => []));
          const fresh = batch.filter((m) => m.MessageId && !seen.has(m.MessageId));
          if (fresh.length === 0) break;
          for (const m of fresh) seen.set(m.MessageId!, letter(m));
        }
        return [...seen.values()].slice(0, max);
      });

      /**
       * Takes dead letters (`ids`, or all) off the queue for `act` to handle, one batch at a time,
       * hidden while it runs. `act` answers whether the letter is done (it's then deleted) or stays
       * (made visible again). Answers how many were done.
       */
      const take = Effect.fnUntraced(function* (
        url: string,
        ids: ReadonlyArray<string> | undefined,
        act: (l: Letter) => Effect.Effect<boolean, AwsError>,
      ) {
        const wanted = ids ? new Set(ids) : undefined;
        const seen = new Set<string>();
        let done = 0;
        for (;;) {
          if (wanted && wanted.size === 0) break;
          const batch = (yield* receive(url, 60)).filter((m) => m.MessageId && !seen.has(m.MessageId));
          if (batch.length === 0) break;
          for (const m of batch) {
            seen.add(m.MessageId!);
            const mine = !wanted || wanted.has(m.MessageId!);
            const finished = mine ? yield* act(letter(m)) : false;
            if (finished) {
              yield* tryAws(() =>
                aws.sqs().send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle })),
              );
              done++;
              wanted?.delete(m.MessageId!);
            } else {
              // Back to the queue at once, for the next look or another redrive.
              yield* tryAws(() =>
                aws.sqs().send(
                  new ChangeMessageVisibilityCommand({
                    QueueUrl: url,
                    ReceiptHandle: m.ReceiptHandle,
                    VisibilityTimeout: 0,
                  }),
                ),
              ).pipe(Effect.ignore);
            }
          }
        }
        return done;
      });

      /** Jobs waiting under a schedule-name prefix in the stage's group. */
      const scheduled = Effect.fnUntraced(function* (group: string, prefix: string) {
        let count = 0;
        let NextToken: string | undefined;
        do {
          const page = yield* tryAws(() =>
            aws
              .scheduler()
              .send(new ListSchedulesCommand({ GroupName: group, NamePrefix: prefix, NextToken })),
          ).pipe(Effect.option);
          if (Option.isNone(page)) return count;
          count += page.value.Schedules?.length ?? 0;
          NextToken = page.value.NextToken;
        } while (NextToken);
        return count;
      });

      const stats = Effect.fn('AppQueues.stats')(function* (
        app: string,
        stage: string,
        queueNames: ReadonlyArray<string>,
      ) {
        if (queueNames.length === 0) return [];
        const letters = yield* peek(yield* deadQueueUrl(app, stage), DEAD_LETTERS_READ);
        const group = names.scheduleGroup(app, stage);
        return yield* Effect.forEach(
          queueNames,
          (name) =>
            Effect.map(scheduled(group, jobSchedulePrefix('queue', name)), (waiting): QueueStats => ({
              name,
              scheduled: waiting,
              deadLetter: letters.filter((l) => l.view?.kind === 'queue' && l.view.name === name).length,
            })),
          { concurrency: 4 },
        );
      });

      const deadLetters = Effect.fn('AppQueues.deadLetters')(function* (app: string, stage: string) {
        const url = yield* deadQueueUrl(app, stage);
        const [count, letters] = yield* Effect.all([total(url), peek(url, DEAD_LETTERS_READ)], {
          concurrency: 'unbounded',
        });
        return { total: Math.max(count, letters.length), items: letters.map(toItem) };
      });

      const redrive = Effect.fn('AppQueues.redrive')(function* (
        app: string,
        stage: string,
        manifest: ResolvedManifest,
        ids: ReadonlyArray<string> | undefined,
      ) {
        const declared = {
          queue: Object.keys(manifest.queues),
          event: manifest.events,
          cron: Object.keys(manifest.crons),
        };
        return yield* take(yield* deadQueueUrl(app, stage), ids, (l) =>
          Effect.gen(function* () {
            const v = l.view;
            if (!v) return false;
            let fn: string;
            if (v.kind === 'invoke') {
              if (!manifest.worker) return false;
              fn = names.workerFunction(app, stage);
            } else {
              if (!declared[v.kind].includes(v.name)) return false;
              fn = handlerFunctionName(app, stage, manifest, v.kind, v.name);
            }
            yield* tryAws(() =>
              aws.lambda().send(
                new InvokeCommand({
                  FunctionName: fn,
                  InvocationType: 'Event',
                  Payload: new TextEncoder().encode(JSON.stringify(v.redrive)),
                }),
              ),
            );
            return true;
          }),
        );
      });

      const discard = Effect.fn('AppQueues.discard')(function* (
        app: string,
        stage: string,
        ids: ReadonlyArray<string> | undefined,
      ) {
        return yield* take(yield* deadQueueUrl(app, stage), ids, () => Effect.succeed(true));
      });

      const runCron = Effect.fn('AppQueues.runCron')(function* (
        app: string,
        stage: string,
        manifest: ResolvedManifest,
        cron: string,
      ) {
        yield* tryAws(() =>
          aws.lambda().send(
            new InvokeCommand({
              FunctionName: handlerFunctionName(app, stage, manifest, 'cron', cron),
              InvocationType: 'Event',
              Payload: new TextEncoder().encode(JSON.stringify({ __platform: 'cron', name: cron })),
            }),
          ),
        );
      }, Effect.orDie);

      return AppQueues.of({ stats, deadLetters, redrive, discard, runCron });
    }),
  );
}

/** What the console shows for a dead letter. */
export function toItem(l: Letter): DeadLetterItem {
  const id = l.message.MessageId ?? '';
  const v = l.view;
  if (!v) {
    return {
      id,
      kind: 'unknown',
      name: '',
      attempts: null,
      error: { name: 'Unknown', message: 'not a message the platform wrote' },
      failedAt: null,
      source: 'unknown',
      preview: (l.message.Body ?? '').slice(0, PREVIEW_CHARS),
    };
  }
  const r = v.redrive;
  const payload = r.__platform === 'invoke' ? r.payload : r.kind === 'event' ? r.detail : r.body;
  return {
    id,
    kind: v.kind,
    name: v.name,
    attempts: v.attempts,
    error: v.error,
    failedAt: v.failedAt === null ? null : new Date(v.failedAt).toISOString(),
    source: v.source,
    preview: payload === undefined ? '' : JSON.stringify(payload).slice(0, PREVIEW_CHARS),
  };
}
