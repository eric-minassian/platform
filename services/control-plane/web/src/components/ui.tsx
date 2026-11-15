import type { ButtonHTMLAttributes, ReactNode } from 'react';

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(' ');

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-border bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h3 className="text-[12px] font-medium tracking-wide text-muted uppercase">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel px-3 py-2.5">
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div className={cx('mt-0.5 text-xl font-semibold tabular-nums', tone && toneText[tone])}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';
const toneText: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-info',
  muted: 'text-muted',
};
const toneBadge: Record<Tone, string> = {
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-bad/15 text-bad',
  info: 'bg-info/15 text-info',
  muted: 'bg-panel-2 text-muted',
};

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        toneBadge[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: Tone }) {
  const bg: Record<Tone, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    bad: 'bg-bad',
    info: 'bg-info',
    muted: 'bg-muted/50',
  };
  return <span className={cx('inline-block size-2 shrink-0 rounded-full', bg[tone])} />;
}

export function statusTone(status: string): Tone {
  if (['succeeded', 'active', 'ok', 'open-ok'].includes(status)) return 'ok';
  if (['failed', 'error', 'open'].includes(status)) return 'bad';
  if (['running', 'queued', 'deploying', 'destroying', 'awaiting_upload'].includes(status)) return 'info';
  if (['rolled_back', 'ignored'].includes(status)) return 'warn';
  return 'muted';
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const styles = {
    default: 'border border-border bg-panel hover:bg-panel-2',
    primary: 'bg-accent text-white hover:opacity-90',
    danger: 'border border-bad/40 text-bad hover:bg-bad/10',
    ghost: 'hover:bg-panel-2 text-muted hover:text-fg',
  } as const;
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    />
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'rounded-md border border-border bg-panel px-2 py-1 text-[12px] outline-none placeholder:text-muted focus:border-accent',
        props.className,
      )}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx(
        'rounded-md border border-border bg-panel px-2 py-1 text-[12px] outline-none focus:border-accent',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  head: ReactNode[];
  children: ReactNode;
  empty?: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr className="border-b border-border text-[11px] tracking-wide text-muted uppercase">
            {head.map((h, i) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: static header list
                key={i}
                className="px-2 py-1.5 font-medium whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-border/60 [&>tr:last-child]:border-0 [&_td]:px-2 [&_td]:py-1.5">
          {children}
        </tbody>
      </table>
      {!hasRows && <Empty>{empty ?? 'Nothing here yet.'}</Empty>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-8 text-center text-[12px] text-muted">{children}</div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-6 text-[12px] text-muted">
      <span className="size-3 animate-spin rounded-full border-2 border-muted/40 border-t-accent" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[11.5px]', className)}>{children}</span>;
}

/** Renders a query's loading/error states, then children. */
export function Loaded<T>({
  q,
  children,
}: {
  q: { data: T | undefined; error: unknown; isPending: boolean };
  children: (data: T) => ReactNode;
}) {
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.isPending || q.data === undefined) return <Spinner />;
  return <>{children(q.data)}</>;
}
