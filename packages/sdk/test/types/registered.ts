// Compiled by `pnpm typecheck` as its own program, so the Register
// augmentation in ./plat.config.ts doesn't leak into the SDK's other tests.
// Every expected error below is a mistake the registered config must catch.
import { events, queue, secrets, storage } from '@ericminassian/platform';
import { defineWorker, type QueueMessage } from '@ericminassian/platform/worker';
import type { EmailJob } from './plat.config.ts';

export async function usage() {
  await queue('emails').send({ to: 'a@example.com' });
  await queue('plain').send(42);
  // @ts-expect-error body doesn't match queue<EmailJob>()
  await queue('emails').send({ email: 'a@example.com' });
  // @ts-expect-error undeclared queue
  queue('emailz');

  await events.publish('todo.created', { id: '1' });
  // @ts-expect-error detail doesn't match event<TodoCreated>()
  await events.publish('todo.created', { id: 1 });
  // @ts-expect-error undeclared event
  await events.publish('todo.deleted', {});

  storage('uploads');
  // @ts-expect-error undeclared store
  storage('upload');
  await secrets.get('STRIPE_KEY');
  // @ts-expect-error undeclared secret
  await secrets.getOptional('STRIPE');
}

export const complete = defineWorker({
  queues: {
    emails: (message) => message.body.to.toUpperCase(),
    plain: (message: QueueMessage<unknown>) => message.id,
  },
  events: { 'todo.created': (event) => event.detail.id },
  crons: { cleanup: () => {} },
  invoke: { anything: (payload: { id: string }) => payload.id },
});

export const missingHandler = defineWorker({
  // @ts-expect-error `plain` has no handler
  queues: { emails: () => {} },
  events: { 'todo.created': () => {} },
  crons: { cleanup: () => {} },
});

export const extraHandler = defineWorker({
  queues: { emails: () => {}, plain: () => {} },
  events: { 'todo.created': () => {} },
  // @ts-expect-error `nightly` isn't a declared cron
  crons: { cleanup: () => {}, nightly: () => {} },
});

export const wrongPayload = defineWorker({
  queues: {
    // @ts-expect-error the handler's type disagrees with queue<EmailJob>()
    emails: (message: QueueMessage<{ email: string }>) => message.body.email,
    plain: () => {},
  },
  events: { 'todo.created': () => {} },
  crons: { cleanup: () => {} },
});

export const annotated = defineWorker({
  queues: { emails: (message: QueueMessage<EmailJob>) => message.body.to, plain: () => {} },
  events: { 'todo.created': () => {} },
  crons: { cleanup: () => {} },
});
