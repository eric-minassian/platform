/**
 * One log line in full, in a panel beside the list (a drawer where the list has no room for it):
 * its level, time and stream, the message, every structured field (each can become a filter), its
 * stack with the app's own frames first, the raw event, its trace, and the lines around it in its
 * stream. ↑ and ↓ step through the list's lines while it is open; Escape closes it.
 */
import { useAtomValue } from '@effect/atom-react';
import type { LogFilters, LogLine, StatusClass } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { AsyncResult } from 'effect/reactivity';
import { ChartGantt, ChevronDown, ChevronUp, Copy, Filter, ScrollText, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiClient, fresh, timeToLive } from '../../client.ts';
import { family } from '../../data/atoms.ts';
import { timeFormat } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { ErrorNotice, Loading, StatusPill, type Tone } from '../page.tsx';
import { Button } from '../ui/button.tsx';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '../ui/drawer.tsx';
import { toast } from '../ui/overlays.tsx';
import { Tip } from '../ui/tooltip.tsx';
import { LogTable, lineKeys } from './log-table.tsx';
import { StackTrace } from './stack.tsx';

const LEVEL_TONE: Record<string, Tone> = {
  error: 'bad',
  warn: 'warn',
  info: 'muted',
  debug: 'muted',
  system: 'muted',
};

/** Fields shown elsewhere in the panel, or that every line has. */
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
  return AsyncResult.match(result, {
    onInitial: () => <Loading rows={8} />,
    onFailure: ({ cause }) => <ErrorNotice error={cause} className="m-5" />,
    onSuccess: ({ value: c }) => {
      // Newest first, as the list reads.
      const lines = c.lines.toReversed();
      const keys = lineKeys(lines);
      return (
        <LogTable
          lines={lines}
          keys={keys}
          utc={utc}
          selected={keys[lines.length - 1 - c.anchor]}
          label="Lines around this one"
          className="min-h-0 flex-1"
        />
      );
    },
  });
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t px-4 py-4 first:border-t-0">
      <header className="mb-2 flex h-6 items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {actions && <div className="ml-auto flex items-center">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function LogDetail({
  app,
  stage,
  line,
  utc,
  inline,
  onClose,
  onStep,
  onFilter,
}: {
  app: string;
  stage: string;
  line: LogLine;
  utc: boolean;
  /** Beside the list; otherwise a drawer over the page. */
  inline: boolean;
  /** `refocus`: focus was in the panel (or a drawer), so it goes back to the list. */
  onClose: (refocus: boolean) => void;
  /** Opens the line before (-1) or after (1) this one in the list. */
  onStep: (delta: -1 | 1) => void;
  onFilter: (patch: Partial<LogFilters>) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState(false);

  // Arrows step through lines while focus is in the panel or nowhere in particular; the list
  // handles its own, and the rest of the page keeps them for scrolling and its controls.
  const stepping = () => {
    const at = document.activeElement;
    return !at || at === document.body || !!panel.current?.contains(at);
  };
  useShortcut('arrowdown', () => onStep(1), {
    layer: panel,
    repeat: true,
    when: stepping,
    description: 'Next line',
  });
  useShortcut('arrowup', () => onStep(-1), {
    layer: panel,
    repeat: true,
    when: stepping,
    description: 'Previous line',
  });
  const close = () => onClose(!!panel.current?.contains(document.activeElement));
  // A drawer closes itself on Escape.
  useShortcut(inline ? 'escape' : null, close, { layer: panel, description: 'Close the line' });

  // Another line starts at the top.
  const id = `${line.ts}|${line.stream}|${line.message}`;
  const shownId = useRef(id);
  useEffect(() => {
    if (shownId.current === id) return;
    shownId.current = id;
    body.current?.scrollTo({ top: 0 });
  }, [id]);

  const event = (line.event ?? {}) as Record<string, unknown>;
  const fields: Array<[string, unknown]> = [
    ['stream', line.stream],
    ...Object.entries(event).filter(([k]) => !HIDDEN.has(k)),
    ...(line.trace && !('trace' in event) ? [['trace', line.trace] as [string, unknown]] : []),
  ];
  const stack = typeof event.stack === 'string' ? event.stack : undefined;
  const json = JSON.stringify(line.event ?? line, null, 2);
  const when = timeFormat(utc, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  const level = line.level ?? 'info';

  const content = (
    <>
      <header
        className={cn('flex shrink-0 items-start gap-2 border-b py-3 pl-4', inline ? 'pr-2.5' : 'pr-14')}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusPill tone={LEVEL_TONE[level] ?? 'muted'}>{level}</StatusPill>
            <time dateTime={line.ts} className="truncate font-mono text-xs text-foreground tabular">
              {when(line.ts)}
              {utc && ' UTC'}
            </time>
          </div>
          <p className="mt-1.5 truncate font-mono text-xs text-muted-foreground" title={line.stream}>
            {line.stream}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tip label="Previous line">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous line"
              aria-keyshortcuts="ArrowUp"
              onClick={() => onStep(-1)}
            >
              <ChevronUp />
            </Button>
          </Tip>
          <Tip label="Next line">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next line"
              aria-keyshortcuts="ArrowDown"
              onClick={() => onStep(1)}
            >
              <ChevronDown />
            </Button>
          </Tip>
          {inline && (
            <Tip label="Close">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close the line"
                aria-keyshortcuts="Escape"
                onClick={close}
              >
                <X />
              </Button>
            </Tip>
          )}
        </div>
      </header>
      <div ref={body} className="min-h-0 flex-1 overflow-y-auto">
        <section className="px-4 py-4">
          <p className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">
            {line.message}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setContext(true)}>
              <ScrollText />
              Show context
            </Button>
            {line.trace && (
              <Button
                variant="outline"
                size="sm"
                render={<Link to="/apps/$app/traces/$trace" params={{ app, trace: line.trace }} />}
              >
                <ChartGantt />
                Open trace
              </Button>
            )}
          </div>
        </section>
        <Section title="Fields">
          <dl className="grid grid-cols-[minmax(4.5rem,auto)_minmax(0,1fr)_auto] gap-x-3 font-mono text-[12px]">
            {fields.map(([key, value]) => {
              const filter = filterFor(key, value, line);
              const text = typeof value === 'string' ? value : JSON.stringify(value);
              return (
                <div
                  key={key}
                  className="group col-span-3 grid grid-cols-subgrid items-start border-b last:border-0"
                >
                  <dt className="truncate py-1.5 text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 py-1.5 break-all text-foreground">
                    {key === 'trace' && typeof value === 'string' ? (
                      <Link
                        to="/apps/$app/traces/$trace"
                        params={{ app, trace: value }}
                        className="rounded-sm text-info outline-hidden hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
                      >
                        {value}
                      </Link>
                    ) : (
                      text
                    )}
                  </dd>
                  <span className="grid min-h-7 w-6 place-items-center">
                    {filter && (
                      <Tip label={`Filter by this ${key}`}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Filter by ${key} ${text}`}
                          className="focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                          onClick={() => onFilter(filter)}
                        >
                          <Filter />
                        </Button>
                      </Tip>
                    )}
                  </span>
                </div>
              );
            })}
          </dl>
        </Section>
        {stack && (
          <Section title="Stack">
            <StackTrace stack={stack} />
          </Section>
        )}
        <Section
          title="Raw"
          actions={
            <Tip label="Copy as JSON">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy the line as JSON"
                onClick={() =>
                  void navigator.clipboard.writeText(json).then(
                    () => toast.success('Copied the line as JSON'),
                    () => toast.error("Couldn't copy to the clipboard"),
                  )
                }
              >
                <Copy />
              </Button>
            </Tip>
          }
        >
          <pre className="overflow-x-auto rounded-lg border bg-muted px-3.5 py-3 font-mono text-[12px] leading-relaxed text-foreground">
            {json}
          </pre>
        </Section>
      </div>
    </>
  );

  return (
    <>
      {inline ? (
        <aside
          ref={panel}
          aria-label="Log line"
          className="flex min-h-0 w-[24rem] shrink-0 flex-col border-l bg-card 2xl:w-[28rem]"
        >
          {content}
        </aside>
      ) : (
        <Drawer open onOpenChange={(open) => !open && onClose(true)}>
          <DrawerContent ref={panel} width="32rem" closeLabel="Close the line">
            <DrawerTitle className="sr-only">Log line</DrawerTitle>
            {content}
          </DrawerContent>
        </Drawer>
      )}
      <Drawer open={context} onOpenChange={setContext}>
        <DrawerContent width="56rem" closeLabel="Close the context">
          <DrawerHeader>
            <DrawerTitle>Lines around this one</DrawerTitle>
            <DrawerDescription>
              {line.stream}, 40 lines either side of {when(line.ts)}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="flex flex-col p-0">
            {context && <Context app={app} stage={stage} line={line} utc={utc} />}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}
