import { log, metrics } from '@ericminassian/platform';
import { defineWorker, type PlatformEvent, type QueueMessage } from '@ericminassian/platform/worker';
import type { EmailJob, TodoCreated } from './types.ts';

// Every key here must match platform.json: `queues`, `events` and `crons`.
// Throwing retries the job (queues: up to maxReceiveCount, then the dead-letter queue).
export default defineWorker({
  queues: {
    emails: async (message: QueueMessage<EmailJob>) => {
      // Swap in a real email provider here (store its API key with `plat secrets set`).
      log.info('would send email', {
        to: message.body.to,
        subject: message.body.subject,
        attempt: message.attempt,
      });
      metrics.count('emails.sent');
    },
  },

  events: {
    'todo.created': async (event: PlatformEvent<TodoCreated>) => {
      log.info('todo created', { id: event.detail.id, userId: event.detail.userId });
    },
  },

  crons: {
    cleanup: async () => {
      log.info('nightly cleanup ran');
      metrics.count('cleanup.runs');
    },
  },
});
