import { channel, defineApp, event, queue } from '@ericminassian/platform/config';

export interface EmailJob {
  to: string;
}
export interface TodoCreated {
  id: string;
}
export interface BoardEvent {
  stroke: number[];
}
export interface Cursor {
  x: number;
  y: number;
}
export interface Notice {
  text: string;
}

const app = defineApp({
  name: 'todo',
  queues: { emails: queue<EmailJob>({ batchSize: 5 }), plain: {} },
  events: { 'todo.created': event<TodoCreated>() },
  crons: { cleanup: '0 3 * * *' },
  storage: { uploads: {}, snapshots: { public: true, expireAfterDays: 7 } },
  secrets: ['STRIPE_KEY'],
  web: { server: 'src/server.ts' },
  auth: true,
  email: { name: 'Todo', dailyLimit: 500 },
  realtime: {
    subscribe: 'signed-in',
    channels: {
      board: channel<BoardEvent>(),
      'boards/*': channel<BoardEvent>(),
      'boards/cursors/*': channel<Cursor>(),
      'user/*': channel<Notice>(),
    },
  },
});
export default app;

declare module '@ericminassian/platform/config' {
  interface Register {
    app: typeof app;
  }
}
