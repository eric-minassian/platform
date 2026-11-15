import { defineWorker, Email, Metrics, Platform } from '@ericminassian/platform';
import { Effect, Schema } from 'effect';
import { EmailJob, TodoCreated } from './domain.ts';

// Handles exactly the `queues`, `events` and `crons` in plat.config.ts (a missing
// or extra handler is a type error). Payloads are decoded again here: a message
// sent by an older deploy that no longer matches fails, retries, and then goes to
// the dead-letter queue, instead of half-running. A failed handler retries the job,
// so an email that wasn't sent (`EmailNotSent`) is tried again before it dead-letters.
export default defineWorker({
  layer: Platform.layer,

  queues: {
    emails: (message) =>
      Effect.gen(function* () {
        const job = yield* Schema.decodeEffect(EmailJob)(message.body);
        const email = yield* Email;
        yield* email.send({ to: job.to, subject: job.subject, text: job.body });
        const metrics = yield* Metrics;
        yield* metrics.count('emails.sent');
      }),
  },

  events: {
    'todo.created': (event) =>
      Effect.gen(function* () {
        const todo = yield* Schema.decodeEffect(TodoCreated)(event.detail);
        yield* Effect.logInfo('todo created').pipe(Effect.annotateLogs({ id: todo.id, userId: todo.userId }));
      }),
  },

  crons: {
    cleanup: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo('nightly cleanup ran');
        const metrics = yield* Metrics;
        yield* metrics.count('cleanup.runs');
      }),
  },
});
