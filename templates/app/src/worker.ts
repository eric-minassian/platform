import { log, metrics } from '@ericminassian/platform';
import { defineWorker } from '@ericminassian/platform/worker';

// Handles exactly the `queues`, `events` and `crons` in plat.config.ts (a missing
// or extra handler is a type error), with the payload types declared there.
// Throwing retries the job (queues: up to maxReceiveCount, then the dead-letter queue).
export default defineWorker({
  queues: {
    emails: async (message) => {
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
    'todo.created': async (event) => {
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
