import { APP_CONFIG_FILE } from '@ericminassian/platform-core';
import type { EventDetail, EventType } from '../register.ts';
import { getBindings } from './bindings.ts';
import { client } from './clients.ts';
import { currentTrace } from './context.ts';
import { span } from './telemetry.ts';

export interface Events {
  /** Publish to this stage's bus. Types are the ones under `events` in `plat.config.ts`. */
  publish<K extends EventType>(type: K, detail: EventDetail<K>): Promise<void>;
}

/** Envelope inside EventBridge `detail`, so the trace survives the hop. */
export interface EventEnvelope<T = unknown> {
  data: T;
  trace: string;
}

export const events: Events = {
  publish: (type, detail) =>
    span('events.publish', type, async () => {
      const b = getBindings();
      if (!b.bus)
        throw new Error(`This app has no event bus. Add an \`events\` entry to ${APP_CONFIG_FILE}.`);
      const envelope: EventEnvelope = { data: detail, trace: currentTrace() };
      const { PutEventsCommand } = await import('@aws-sdk/client-eventbridge');
      const out = await (await client('events')).send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: b.bus.name,
              Source: `platform.${b.app}`,
              DetailType: type,
              Detail: JSON.stringify(envelope),
            },
          ],
        }),
      );
      if (out.FailedEntryCount) {
        const e = out.Entries?.find((x) => x.ErrorCode);
        throw new Error(
          `events.publish("${type}") failed: ${e?.ErrorCode ?? 'unknown'} ${e?.ErrorMessage ?? ''}`.trim(),
        );
      }
    }),
};
