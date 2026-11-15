/**
 * `@ericminassian/platform/config`: what `plat.config.ts` imports. The CLI
 * evaluates that file, so this entry must stay free of runtime SDK code (AWS
 * clients, telemetry).
 *
 * `plat.config.ts` also registers the app's config here (`declare module
 * '@ericminassian/platform/config' { interface Register { app: typeof app } }`):
 * it's the one SDK module every app's program is sure to include.
 */

export {
  type AppConfig,
  type CronConfig,
  defineApp,
  type EventConfig,
  event,
  type QueueConfig,
  queue,
  type WebConfig,
  type WorkerConfig,
} from '@ericminassian/platform-core';
export type { Register } from './register.ts';
