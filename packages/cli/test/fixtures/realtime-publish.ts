// Publishes one realtime event the way deployed code does: the SDK, with the
// stage's bindings and credentials in the environment (`localEnv`).
// Usage: node realtime-publish.ts <channel> <event JSON>
import { realtime } from '@ericminassian/platform';

const [channel, event] = process.argv.slice(2);
if (!channel || !event) throw new Error('usage: realtime-publish.ts <channel> <event JSON>');
await realtime.publish(channel as never, JSON.parse(event));
