/**
 * One log line in full: its message, every structured field (each can
 * become a filter), its stack with the app's own frames first, its trace,
 * and the lines around it in its stream.
 */
import { useAtomValue } from '@effect/atom-react';
import type { LogFilters, LogLine, StatusClass } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { ChartGantt, Copy, Filter, ScrollText, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { family } from '../../data/atoms.ts';
import { timeFormat } from '../../lib/time.ts';
import { cn, keyed } from '../../lib/utils.ts';
import { Loaded, StatusPill, type Tone } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.tsx';
import { LogTable } from './log-table.tsx';

const LEVEL_TONE: Record<string, Tone> = {
  error: 'bad',
  warn: 'warn',
  info: 'info',
  debug: 'muted',
  system: 'muted',
};

/** Fields shown elsewhere in the drawer, or that every line has. */
const HIDDEN = new Set(['_p', 'ts', 'app', 'stage', 't', 'msg', 'message', 'stack', 'level']);

/** What filter a field adds, when it can be one. */
function filterFor(key: string, value: unknown, line: LogLine): Partial<LogFilters> | undefined {
  if (key === 'route' && typeof value === 'string') return { routes: [value] };
  if (key === 'rev' && typeof value === 'string') return { revs: [value] };
  if (key === 'trace' && typeof value === 'string') return { trace: value };
  if (key === 'status' && typeof value === 'number')
    return { status: [`${String(value)[0]}xx` as StatusClass] };
  if (key === 'stream') return { streams: [line.stream] };
  return undefined;
}

/** A stack's lines, the message and the app's own frames marked (node internals and dependencies fade). */
export function stackFrames(stack: string): Array<{ key: string; frame: string; own: boolean }> {
  return keyed(stack.split('\n'), (frame) => frame).map(({ key, item: frame }, i) => ({
    key,
    frame,
    own: i === 0 || !/node:internal|node_modules/.test(frame),
  }));
}

const contextAtom = family((k: { app: string; stage: string; stream: string; ts: number }) =>
  fresh(
    ApiClient.query('observe', 'logContext', {
      params: { app: k.app },
      query: { stage: k.stage, stream: k.stream, ts: String(k.ts), before: 40, after: 40 },
      timeToLive,
    }),
    { staleTime: '5 minutes' },
  ),
);

function Context({ app, stage, line, utc }: { app: string; stage: string; line: LogLine; utc: boolean }) {
  const result = useAtomValue(contextAtom({ app, stage, stream: line.stream, ts: Date.parse(line.ts) }));
  return (
    <Loaded result={result}>
      {(c) => (
        <LogTable
          lines={c.lines.toReversed()}
          utc={utc}
          selected={`${c.lines[c.anchor]?.ts}|${c.lines[c.anchor]?.stream}|${c.lines.length - 1 - c.anchor}`}
          className="h-[calc(100svh-9rem)]"
        />
      )}
    </Loaded>
  );
}

export function LogDrawer({
  app,
  stage,
  line,
  utc,
  onClose,
  onFilter,
}: {
  app: string;
  stage: string;
  line: LogLine;
  utc: boolean;
  onClose: () => void;
  onFilter: (patch: Partial<LogFilters>) => void;
}) {
  const [context, setContext] = useState(false);
  const event = (line.event ?? {}) as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['stream', line.stream],
    ...Object.entries(event).filter(([k]) => !HIDDEN.has(k)),
    ...(line.trace && !('trace' in event) ? [['trace', line.trace] as [string, unknown]] : []),
  ];
  const stack = typeof event.stack === 'string' ? event.stack : undefined;
  const when = timeFormat(utc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
  const level = line.level ?? 'info';
  return (
    <aside
      className="flex min-h-0 w-[22rem] shrink-0 flex-col border-l bg-card xl:w-[26rem]"
      aria-label="Log line"
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <StatusPill tone={LEVEL_TONE[level] ?? 'muted'}>{level}</StatusPill>
        <span className="truncate font-mono text-xs text-muted-foreground">{when(line.ts)}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
          {line.message}
        </p>
        <div className="flex flex-wrap gap-2">
          {line.trace && (
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/apps/$app/traces/$trace" params={{ app, trace: line.trace }} />}
            >
              <ChartGantt />
              Open trace
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setContext(true)}>
            <ScrollText />
            Lines around this
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void navigator.clipboard.writeText(JSON.stringify(line.event ?? line, null, 2)).then(
                () => toast.success('Copied the line as JSON'),
                () => toast.error("Couldn't copy to the clipboard"),
              )
            }
          >
            <Copy />
            Copy JSON
          </Button>
        </div>
        <dl className="grid grid-cols-[6.5rem_1fr_auto] border-t font-mono text-[12px]">
          {fields.map(([key, value]) => {
            const filter = filterFor(key, value, line);
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            return (
              <div key={key} className="contents">
                <dt className="truncate border-b py-1.5 pr-2 text-muted-foreground">{key}</dt>
                <dd className="min-w-0 border-b py-1.5 break-all text-foreground">
                  {key === 'trace' && typeof value === 'string' ? (
                    <Link
                      to="/apps/$app/traces/$trace"
                      params={{ app, trace: value }}
                      className="text-info hover:underline"
                    >
                      {value}
                    </Link>
                  ) : (
                    text
                  )}
                </dd>
                <span className="grid place-items-center border-b">
                  {filter && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Filter by ${key} ${text}`}
                      onClick={() => onFilter(filter)}
                    >
                      <Filter />
                    </Button>
                  )}
                </span>
              </div>
            );
          })}
        </dl>
        {stack && (
          <section>
            <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Stack</h3>
            <pre className="overflow-x-auto rounded-md border bg-background p-3 font-mono text-[11.5px] leading-relaxed">
              {stackFrames(stack).map(({ key, frame, own }) => (
                <span key={key} className={cn('block', own ? 'text-foreground' : 'text-subtle')}>
                  {frame}
                </span>
              ))}
            </pre>
          </section>
        )}
      </div>
      <Sheet open={context} onOpenChange={setContext}>
        <SheetContent side="right" size="xl" className="gap-0">
          <SheetHeader>
            <SheetTitle>Lines around this one</SheetTitle>
            <SheetDescription>
              {line.stream}, 40 lines either side of {when(line.ts)}
            </SheetDescription>
          </SheetHeader>
          {context && <Context app={app} stage={stage} line={line} utc={utc} />}
        </SheetContent>
      </Sheet>
    </aside>
  );
}
