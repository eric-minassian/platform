// Copied to a temp dir without node_modules by the tests, so only a type
// import (erased when the CLI evaluates this file) is possible here.
import type { AppConfig } from '@ericminassian/platform/config';

export default {
  name: 'basic-app',
  web: { server: 'src/server.ts', static: 'public', spa: true },
  db: true,
  queues: { jobs: {} },
  crons: { tick: { schedule: '*/5 * * * *', timeoutSeconds: 30 } },
} satisfies AppConfig;
