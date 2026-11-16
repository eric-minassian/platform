/**
 * Log lines as a windowed table: only the rows in view are drawn, so thousands scroll smoothly, and
 * the next page loads as the end comes into view. Errors and warnings carry
 * a colored edge; the matched text is highlighted.
 */
import type { LogLine } from '@ericminassian/platform-core';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { timeFormat } from '../../lib/time.ts';
import { cn } from '../../lib/utils.ts';
import { Spinner } from '../ui/spinner.tsx';

const ROW = 28;
const OVERSCAN = 20;

/**
 * The rows to draw: those in the scroller's view and some either side. Every
 * row is `ROW` tall, so where each sits follows from its index.
 */
function useRowWindow(scroller: RefObject<HTMLDivElement | null>, count: number) {
  const [view, setView] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight });
    // A ResizeObserver reports once when it starts, which takes the first reading.
    const resize = new ResizeObserver(read);
    resize.observe(el);
    el.addEventListener('scroll', read, { passive: true });
    return () => {
      resize.disconnect();
      el.removeEventListener('scroll', read);
    };
  }, [scroller]);
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(count - 1, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  return { first, last };
}

export const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--s5xx)',
  warn: 'var(--s4xx)',
  info: 'var(--chart-1)',
  debug: 'var(--subtle)',
  system: 'var(--input)',
};

const LEVEL_TEXT: Record<string, string> = {
  error: 'text-bad',
  warn: 'text-warn',
  info: 'text-muted-foreground',
  debug: 'text-subtle',
  system: 'text-subtle',
};

/** A service's stream is `service:<name>`; its name fits the column. */
export const streamLabel = (stream: string): string =>
  stream.startsWith('service:') ? stream.slice(8) : stream;

export const lineKey = (l: LogLine, i: number): string => `${l.ts}|${l.stream}|${i}`;

function highlight(text: string, q: string | undefined): ReactNode {
  const needle = q?.trim();
  if (!needle || needle.startsWith('{') || needle.startsWith('"')) return text;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-warn-mark/30 text-foreground">
        {text.slice(i, i + needle.length)}
      </mark>
      {text.slice(i + needle.length)}
    </>
  );
}

export function LogTable({
  lines,
  q,
  utc,
  selected,
  onSelect,
  hasMore,
  loadingMore,
  onLoadMore,
  className,
  empty,
  withDate = true,
}: {
  lines: readonly LogLine[];
  q?: string | undefined;
  utc: boolean;
  selected?: string | undefined;
  onSelect?: (line: LogLine, key: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  className?: string;
  empty?: ReactNode;
  /** Show the day too (windows longer than a day); otherwise only the time. */
  withDate?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = lines.length + (hasMore ? 1 : 0);
  const { first, last } = useRowWindow(scroller, count);
  useEffect(() => {
    if (hasMore && !loadingMore && last >= lines.length - 1) onLoadMore?.();
  }, [hasMore, loadingMore, last, lines.length, onLoadMore]);
  const rows = Array.from({ length: Math.max(0, last - first + 1) }, (_, n) => first + n);
  const time = timeFormat(utc, {
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  const cols = withDate ? 'grid-cols-[9.5rem_3.25rem_4.5rem_1fr]' : 'grid-cols-[6.25rem_3.25rem_4.5rem_1fr]';

  return (
    <div className={cn('flex min-h-0 flex-col font-mono text-[12px]', className)}>
      <div
        className={cn(
          'grid h-8 shrink-0 items-center gap-3 border-b px-4 font-sans text-xs font-medium text-muted-foreground',
          cols,
        )}
      >
        <span>Time</span>
        <span>Level</span>
        <span>Stream</span>
        <span>Message</span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          (empty ?? null)
        ) : (
          <ul aria-label="Log lines" className="relative w-full" style={{ height: count * ROW }}>
            {rows.map((index) => {
              const line = lines[index];
              if (!line) {
                return (
                  <li
                    key="more"
                    className="absolute inset-x-0 flex items-center gap-2 px-4 font-sans text-xs text-muted-foreground"
                    style={{ top: index * ROW, height: ROW }}
                  >
                    <Spinner className="size-3" /> Loading older lines
                  </li>
                );
              }
              const key = lineKey(line, index);
              const level = line.level ?? 'info';
              return (
                <li key={key} className="absolute inset-x-0" style={{ top: index * ROW, height: ROW }}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(line, key)}
                    aria-current={selected === key || undefined}
                    className={cn(
                      'grid size-full items-center gap-3 border-l-2 border-transparent px-4 pl-[14px] text-left outline-none hover:bg-accent/60 focus-visible:bg-accent aria-current:bg-accent',
                      level === 'error' && 'border-l-bad-mark',
                      level === 'warn' && 'border-l-warn-mark',
                      cols,
                    )}
                  >
                    <span className="truncate text-muted-foreground tabular">{time(line.ts)}</span>
                    <span className={LEVEL_TEXT[level] ?? 'text-muted-foreground'}>{level}</span>
                    <span className="truncate text-muted-foreground" title={line.stream}>
                      {streamLabel(line.stream)}
                    </span>
                    <span className={cn('truncate', level === 'system' ? 'text-subtle' : 'text-foreground')}>
                      {highlight(line.message, q)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
