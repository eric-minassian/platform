import { defineApp, event, queue } from '@ericminassian/platform/config';

export interface EmailJob {
  to: string;
}
export interface TodoCreated {
  id: string;
}

const app = defineApp({
  name: 'todo',
  queues: { emails: queue<EmailJob>({ batchSize: 5 }), plain: {} },
  events: { 'todo.created': event<TodoCreated>() },
  crons: { cleanup: '0 3 * * *' },
  storage: ['uploads'],
  secrets: ['STRIPE_KEY'],
});
export default app;

declare module '@ericminassian/platform' {
  interface Register {
    app: typeof app;
  }
}
