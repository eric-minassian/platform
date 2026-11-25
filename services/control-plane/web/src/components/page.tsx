/**
 * The building blocks every page uses: its header, cards, figures, status,
 * and the loading, error and empty states of a query.
 */
import { AsyncResult } from 'effect/reactivity';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../client.ts';
import { cn } from '../lib/utils.ts';
import { Skeleton } from './ui/skeleton.tsx';

export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-1">
      <div className="min-w-0 flex-1">
        <h1 className="flex min-w-0 items-center gap-3 text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
        {description && <div className="mt-1.5 text-sm text-pretty text-muted-foreground">{description}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled section of a page without a box around it, for lists that carry their own. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      <header className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A bordered card with an optional header row. */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  flush = false,
  footer,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Content runs edge to edge (tables, lists). */
  flush?: boolean;
  /** A tinted band under the content, for notes and actions. */
  footer?: ReactNode;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col rounded-xl border bg-card', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4 pb-2">
          <div className="min-w-0 flex-1">
            {title && <h2 className="truncate text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div
        className={cn(
          'min-w-0 flex-1',
          flush ? 'pb-1' : 'px-5 pb-5',
          !title && !actions && !flush && 'pt-5',
          bodyClassName,
        )}
      >
        {children}
      </div>
      {footer && (
        <footer className="flex flex-wrap items-center gap-2 rounded-b-xl border-t bg-muted px-5 py-3 text-[13px] text-muted-foreground">
          {footer}
        </footer>
      )}
    </section>
  );
}

/** Figures side by side in one card, divided by hairlines; they wrap to a grid on narrow screens. */
export function Stats({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        'grid min-w-0 grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]',
        '[&>*]:-mt-px [&>*]:-ml-px [&>*]:border-t [&>*]:border-l',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** One figure with its label, an optional note and a small trend. In `Stats` it draws no box of its own. */
export function Stat({
  label,
  value,
  note,
  tone,
  trend,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone | undefined;
  trend?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid min-w-0 grid-cols-[1fr_auto] gap-x-3 px-5 py-4', className)}>
      <div className="col-span-2 truncate text-[13px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          'col-start-1 row-start-2 mt-1 truncate text-2xl font-semibold tracking-tight tabular',
          tone && TONE_TEXT[tone],
        )}
      >
        {value}
      </div>
      {trend && <div className="col-start-2 row-start-2 self-end pb-1">{trend}</div>}
      {note && <div className="col-span-2 mt-0.5 truncate text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  muted: 'text-muted-foreground',
};

const TONE_PILL: Record<Tone, string> = {
  ok: 'bg-ok-mark/12 text-ok',
  warn: 'bg-warn-mark/15 text-warn',
  bad: 'bg-bad-mark/12 text-bad',
  info: 'bg-info-mark/12 text-info',
  muted: 'bg-accent text-muted-foreground',
};

const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-ok-mark',
  warn: 'bg-warn-mark',
  bad: 'bg-bad-mark',
  info: 'bg-info-mark',
  muted: 'bg-subtle',
};

/** A status in words, with its color as a second cue. */
export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        TONE_PILL[tone],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
      {children}
    </span>
  );
}

/** A status as a dot and its word, the way Vercel lists a deployment's state. */
export function StatusText({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', TONE_DOT[tone])} />
      {children}
    </span>
  );
}

export function StatusDot({ tone, className, label }: { tone: Tone; className?: string; label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      title={label}
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT[tone], className)}
    />
  );
}

/** How a deployment, stage or job status reads. */
export function statusTone(status: string): Tone {
  if (['succeeded', 'active', 'ok', 'up', 'resolved'].includes(status)) return 'ok';
  if (['failed', 'error', 'open', 'alarm', 'down'].includes(status)) return 'bad';
  if (['running', 'queued', 'deploying', 'destroying', 'awaiting_upload', 'pending'].includes(status))
    return 'info';
  if (['rolled_back', 'ignored', 'no_data'].includes(status)) return 'warn';
  return 'muted';
}

export function EmptyState({
  title,
  children,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-6 py-12 text-center', className)}>
      {icon && (
        <div className="mb-2 grid size-10 place-items-center rounded-lg border bg-background text-muted-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)] [&>svg]:size-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-pretty text-muted-foreground">{children}</div>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ error, className }: { error: unknown; className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-bad-mark/30 bg-bad-mark/8 px-3 py-2.5 text-sm text-bad',
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{errorMessage(error)}</span>
    </div>
  );
}

/** A notice that isn't an error: something to know or to fix soon. */
export function Notice({
  tone = 'info',
  children,
  action,
  className,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3.5 py-2.5 text-sm',
        tone === 'warn'
          ? 'border-warn-mark/40 bg-warn-mark/8 text-warn'
          : 'border-info-mark/30 bg-info-mark/8 text-info',
        className,
      )}
    >
      <div className="min-w-0 flex-1 [&_code]:font-mono [&_code]:text-[13px]">{children}</div>
      {action}
    </div>
  );
}

/** A placeholder the size of what's loading, so the page doesn't jump when it arrives. */
export function Loading({ className, rows = 0 }: { className?: string; rows?: number }) {
  if (rows) {
    return (
      <div className={cn('space-y-2.5 p-5', className)} aria-busy>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  return <Skeleton aria-busy className={cn('h-40 w-full', className)} />;
}

/**
 * A query's value, or its loading and error states. While a refetch runs the
 * previous value stays on screen, dimmed.
 */
export function Loaded<A, E>({
  result,
  children,
  loading,
}: {
  result: AsyncResult.AsyncResult<A, E>;
  children: (value: A) => ReactNode;
  loading?: ReactNode;
}) {
  return AsyncResult.match(result, {
    onInitial: () => <>{loading ?? <Loading />}</>,
    onFailure: ({ cause, previousSuccess }) =>
      previousSuccess._tag === 'Some' ? (
        <>
          <ErrorNotice error={cause} className="mb-3" />
          {children(previousSuccess.value.value)}
        </>
      ) : (
        <ErrorNotice error={cause} />
      ),
    onSuccess: ({ value, waiting }) => (
      <div className={cn('transition-opacity', waiting && 'opacity-70')}>{children(value)}</div>
    ),
  });
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[0.8125rem]', className)}>{children}</span>;
}

/** A `METHOD /route` with the method set apart. */
export function RouteLabel({ route, className }: { route: string; className?: string }) {
  const space = route.indexOf(' ');
  const method = space > 0 ? route.slice(0, space) : undefined;
  const path = space > 0 ? route.slice(space + 1) : route;
  return (
    <span className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)}>
      {method && <span className="font-mono text-[0.6875rem] font-medium text-subtle">{method}</span>}
      <span className="truncate font-mono text-[0.8125rem]">{path}</span>
    </span>
  );
}

/** Label and value pairs, for the facts about one thing. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-6 gap-y-2.5 text-sm', className)}>
      {children}
    </dl>
  );
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** A label over its value, for the facts about one thing laid out in a grid. */
export function Detail({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="min-w-0 text-sm font-medium">{children}</div>
    </div>
  );
}
