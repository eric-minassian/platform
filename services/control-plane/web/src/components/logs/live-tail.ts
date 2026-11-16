/** The live tail: lines as CloudWatch Live Tail delivers them, over server-sent events. */
import type { LogLine } from '@ericminassian/platform-core';
import { TailEvent } from '@ericminassian/platform-core/platform-api';
import { Schema } from 'effect';
import { useEffect, useState } from 'react';

// The tail's server-sent events are `{ event, data }` pairs, as `PlatformApi` describes them.
const decodeTailEvent = Schema.decodeUnknownOption(TailEvent);

/** The most lines a tail keeps; older ones drop off the end. */
export const TAIL_LIMIT = 5000;

interface Tail {
  /** The URL these lines came from: a new URL starts a new tail. */
  readonly url: string;
  readonly lines: LogLine[];
  readonly error: string | null;
}

/** Newest first. `paused` keeps the connection but holds the list still, so it can be read. */
export function useLiveTail(url: string | undefined, paused: boolean) {
  const [tail, setTail] = useState<Tail>({ url: url ?? '', lines: [], error: null });
  const [held, setHeld] = useState<LogLine[]>([]);
  if (url !== undefined && tail.url !== url) setTail({ url, lines: [], error: null });
  useEffect(() => {
    if (!url) return undefined;
    const es = new EventSource(url, { withCredentials: true });
    // A dropped connection fires a plain `error` event without data, which doesn't decode.
    const onEvent = (e: Event) => {
      const decoded = decodeTailEvent({ event: e.type, data: (e as MessageEvent<unknown>).data });
      if (decoded._tag === 'None') return;
      const event = decoded.value;
      setTail((prev) => {
        // The previous URL's source can still deliver an event until its cleanup closes it.
        if (prev.url !== url) return prev;
        return event.event === 'line'
          ? { ...prev, lines: [event.data, ...prev.lines].slice(0, TAIL_LIMIT) }
          : { ...prev, error: event.data };
      });
    };
    es.addEventListener('line', onEvent);
    es.addEventListener('error', onEvent);
    return () => es.close();
  }, [url]);
  // While paused, the list shown stays as it was when the pause began.
  if (!paused && held.length) setHeld([]);
  if (paused && held.length === 0 && tail.lines.length) setHeld(tail.lines);
  return { lines: paused && held.length ? held : tail.lines, waiting: tail.lines.length, error: tail.error };
}
