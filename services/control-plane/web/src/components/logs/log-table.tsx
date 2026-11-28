/**
 * Log lines as a dense, windowed list: only the rows in view are drawn, so thousands scroll
 * smoothly, and the next page loads as the end comes into view. With `onSelect` it is a listbox: a
 * press or Enter opens a line, and while one is open the arrow keys move the selection with focus.
 */
import type { LogLine } from '@ericminassian/platform-core';
import { Listbox, ListboxItem, type ListboxController } from '@ui-sdk/react/listbox';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { timeFormat } from '../../lib/time.ts';
import { cn, keyed } from '../../lib/utils.ts';
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

/** Brings row `index` into view: by the least scroll for a neighbour, centered after a jump. */
function reveal(el: HTMLElement, index: number) {
  const top = index * ROW;
  const view = el.clientHeight;
  if (top >= el.scrollTop && top + ROW <= el.scrollTop + view) return;
  const near = top >= el.scrollTop - ROW && top <= el.scrollTop + view;
  if (!near) el.scrollTop = top - (view - ROW) / 2;
  else el.scrollTop = top < el.scrollTop ? top : top + ROW - view;
}

/** Each level's color in the volume chart, the facets and the rows: errors and warnings stand out of grey. */
export const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--s5xx)',
  warn: 'var(--s4xx)',
  info: 'color-mix(in oklab, var(--subtle) 60%, transparent)',
  debug: 'color-mix(in oklab, var(--subtle) 35%, transparent)',
  system: 'var(--input)',
};

const LEVEL_TEXT: Record<string, string> = {
  error: 'text-bad',
  warn: 'text-warn',
  info: 'text-muted-foreground',
  debug: 'text-subtle',
  system: 'text-subtle',
};

/** Keys that follow a line as newer lines arrive above it (an index wouldn't). */
export const lineKeys = (lines: readonly LogLine[]): string[] =>
  keyed(lines, (l) => `${l.ts}|${l.stream}|${l.message}`).map((k) => k.key);

function highlight(text: string, q: string | undefined): ReactNode {
  const needle = q?.trim();
  if (!needle || needle.startsWith('{') || needle.startsWith('"') || needle.startsWith('?')) return text;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-warn-mark/35 text-foreground">
        {text.slice(i, i + needle.length)}
      </mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/** Narrow lists (a detail panel beside them) drop the stream column. */
const COLS = {
  date: 'grid-cols-[9.25rem_3.75rem_minmax(0,1fr)] @2xl:grid-cols-[9.25rem_3.75rem_6rem_minmax(0,1fr)]',
  time: 'grid-cols-[6.5rem_3.75rem_minmax(0,1fr)] @2xl:grid-cols-[6.5rem_3.75rem_6rem_minmax(0,1fr)]',
};

/** Errors and warnings sit on a tint of their color, so they stand out of a long list. */
const ROW_TINT: Record<string, string> = {
  error: 'bg-bad-mark/[0.07]',
  warn: 'bg-warn-mark/[0.08]',
};

const ROW_HOVER: Record<string, string> = {
  error: 'hover:bg-bad-mark/12',
  warn: 'hover:bg-warn-mark/14',
};

const rowLook = (level: string) =>
  cn('absolute inset-x-0 grid items-center gap-3 px-5 outline-hidden', ROW_TINT[level]);

function Cells({ line, q, time }: { line: LogLine; q: string | undefined; time: (ts: string) => string }) {
  const level = line.level ?? 'info';
  return (
    <>
      <span className="truncate text-muted-foreground tabular">{time(line.ts)}</span>
      <span className={cn('flex items-center gap-1.5', LEVEL_TEXT[level] ?? 'text-muted-foreground')}>
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: LEVEL_COLORS[level] ?? 'var(--subtle)' }}
        />
        {level}
      </span>
      <span className="hidden truncate text-muted-foreground @2xl:block">{line.stream}</span>
      <span className={cn('truncate', level === 'system' ? 'text-subtle' : 'text-foreground')}>
        {highlight(line.message, q)}
      </span>
    </>
  );
}

export function LogTable({
  lines,
  keys = lineKeys(lines),
  q,
  utc,
  selected,
  onSelect,
  following = false,
  controller,
  hasMore,
  loadingMore,
  onLoadMore,
  className,
  empty,
  withDate = true,
  label = 'Log lines',
}: {
  lines: readonly LogLine[];
  /** Each line's key, from `lineKeys(lines)`. */
  keys?: readonly string[];
  q?: string | undefined;
  utc: boolean;
  /** The open line's key: marked, and kept in view as it changes. */
  selected?: string | undefined;
  /** Makes the list a listbox whose choice opens a line. */
  onSelect?: (line: LogLine, key: string) => void;
  /** Whether moving focus through the list moves the selection with it (a line is open). */
  following?: boolean;
  controller?: ListboxController | undefined;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  className?: string;
  empty?: ReactNode;
  /** Show the day too (windows longer than a day); otherwise only the time. */
  withDate?: boolean;
  label?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const count = lines.length + (hasMore ? 1 : 0);
  const { first, last } = useRowWindow(scroller, count);
  useEffect(() => {
    if (hasMore && !loadingMore && last >= lines.length - 1) onLoadMore?.();
  }, [hasMore, loadingMore, last, lines.length, onLoadMore]);

  const items = useMemo(() => lines.map((l, i) => ({ value: keys[i]!, label: l.message })), [lines, keys]);
  const selectedIndex = selected === undefined ? -1 : keys.indexOf(selected);
  // A selection moved from outside the list (the panel's keys) scrolls to its row, and the list's
  // tab stop follows it once the row is drawn, so Tab and closing the panel land there. Only a new
  // selection scrolls: lines loading or arriving leave the scroll position alone.
  const shown = useRef<string | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selected === shown.current) return;
    shown.current = selected;
    const el = scroller.current;
    if (!el || selected === undefined || selectedIndex < 0) return;
    if (!el.contains(document.activeElement)) reveal(el, selectedIndex);
    pending.current = selected;
  }, [selected, selectedIndex]);
  useEffect(() => {
    const key = pending.current;
    if (!controller || key === undefined || selectedIndex < first || selectedIndex > last) return;
    pending.current = undefined;
    if (!scroller.current?.contains(document.activeElement)) controller.highlight(key);
  }, [controller, selectedIndex, first, last]);

  const rows = Array.from(
    { length: Math.max(0, Math.min(last, lines.length - 1) - first + 1) },
    (_, n) => first + n,
  );
  const time = timeFormat(utc, {
    ...(withDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  const cols = withDate ? COLS.date : COLS.time;
  const byKey = (key: string | null) => {
    const i = key === null ? -1 : keys.indexOf(key);
    return i < 0 ? undefined : { line: lines[i]!, key: keys[i]! };
  };

  return (
    <div className={cn('@container flex min-h-0 flex-col font-mono text-[12px]', className)}>
      <div
        aria-hidden
        className={cn(
          'grid h-8 shrink-0 items-center gap-3 border-b px-5 font-sans text-xs font-medium text-muted-foreground',
          cols,
        )}
      >
        <span>Time</span>
        <span>Level</span>
        <span className="hidden @2xl:block">Stream</span>
        <span>Message</span>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="font-sans">{empty}</div>
        ) : onSelect ? (
          <Listbox
            aria-label={label}
            activation="manual"
            value={selected ?? null}
            items={items}
            controller={controller}
            onValueChange={(key) => {
              const hit = byKey(key);
              if (hit) onSelect(hit.line, hit.key);
            }}
            onHighlight={(key, { index }) => {
              if (index >= 0 && scroller.current) reveal(scroller.current, index);
              const hit = following && key !== selected ? byKey(key) : undefined;
              if (hit) onSelect(hit.line, hit.key);
            }}
            className="relative w-full outline-hidden"
            style={{ height: lines.length * ROW }}
          >
            {rows.map((index) => {
              const line = lines[index]!;
              const level = line.level ?? 'info';
              return (
                <ListboxItem
                  key={keys[index]}
                  value={keys[index]!}
                  index={index}
                  label={line.message}
                  className={cn(
                    rowLook(level),
                    cols,
                    ROW_HOVER[level] ?? 'hover:bg-muted',
                    'cursor-default focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring data-selected:bg-accent data-selected:shadow-[inset_2px_0_0_var(--foreground)]',
                  )}
                  style={{ top: index * ROW, height: ROW }}
                >
                  <Cells line={line} q={q} time={time} />
                </ListboxItem>
              );
            })}
          </Listbox>
        ) : (
          <ol aria-label={label} className="relative w-full" style={{ height: lines.length * ROW }}>
            {rows.map((index) => {
              const line = lines[index]!;
              const level = line.level ?? 'info';
              const current = index === selectedIndex;
              return (
                <li
                  key={keys[index]}
                  aria-current={current || undefined}
                  className={cn(
                    rowLook(level),
                    cols,
                    current && 'bg-accent shadow-[inset_2px_0_0_var(--foreground)]',
                  )}
                  style={{ top: index * ROW, height: ROW }}
                >
                  <Cells line={line} q={q} time={time} />
                </li>
              );
            })}
          </ol>
        )}
        {hasMore && lines.length > 0 && (
          <div
            className="flex items-center gap-2 px-5 font-sans text-xs text-muted-foreground"
            style={{ height: ROW }}
          >
            <Spinner className="size-3" /> Loading older lines
          </div>
        )}
      </div>
    </div>
  );
}
