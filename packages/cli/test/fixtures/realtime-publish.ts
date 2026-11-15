// Publishes one realtime event the way deployed code does: the SDK's Realtime
// service, with the stage's bindings and credentials in the environment
// (`localEnv`). Usage: node realtime-publish.ts <channel> <event JSON>
import { Platform, Realtime } from '@ericminassian/platform';
import { Effect } from 'effect';

const [channel, event] = process.argv.slice(2);
if (!channel || !event) throw new Error('usage: realtime-publish.ts <channel> <event JSON>');
await Effect.runPromise(
  Effect.gen(function* () {
    const realtime = yield* Realtime;
    yield* realtime.publish(channel as never, JSON.parse(event));
  }).pipe(Effect.provide(Platform.layer)),
);
