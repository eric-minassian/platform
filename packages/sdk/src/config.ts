/**
 * `@ericminassian/platform/config`: what `plat.config.ts` imports. The CLI
 * evaluates that file, so this entry must stay free of runtime SDK code (AWS
 * clients, telemetry).
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
