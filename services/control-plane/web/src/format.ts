export const fmtNum = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? '—'
    : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export const fmtMs = (n: number | null | undefined): string =>
  n === null || n === undefined
    ? '—'
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`
      : `${Math.round(n)}ms`;

export const fmtPct = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : `${(n * 100).toFixed(digits)}%`;

export const fmtUsd = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

export function relTime(iso: string | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - Date.parse(iso);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const fmtDateTime = (iso: string | number): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Axis tick: time of day for short ranges, date for long ones. */
export function tickFormatter(range: string): (v: string) => string {
  const long = /^(\d+)d$/.test(range) && Number.parseInt(range, 10) > 2;
  return (v) =>
    long
      ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const shortId = (id: string | undefined): string => (id ? id.slice(-8) : '—');

export function duration(start?: string, end?: string): string {
  if (!start || !end) return '—';
  return fmtMs(Date.parse(end) - Date.parse(start));
}
