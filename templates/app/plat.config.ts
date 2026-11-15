import { defineApp, event, queue } from '@ericminassian/platform/config';
import type { EmailJob, TodoCreated } from './src/types.ts';

// Everything this app needs from the platform. `plat` evaluates this file and
// provisions what it declares; the SDK checks names and payload types in code
// against it (see `Register` below).
const app = defineApp({
  name: 'template-app',
  description: 'A todo app on the platform',
  web: {
    server: 'src/server.ts',
    static: 'web/dist',
    build: 'vite build --config web/vite.config.ts',
    dev: { command: 'vite --config web/vite.config.ts' },
    spa: true,
  },
  auth: true,
  db: true,
  queues: { emails: queue<EmailJob>() },
  events: { 'todo.created': event<TodoCreated>() },
  crons: { cleanup: '0 3 * * *' },
  storage: ['uploads'],
});

export default app;

declare module '@ericminassian/platform' {
  interface Register {
    app: typeof app;
  }
}
