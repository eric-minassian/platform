/**
 * The log page's facets: each field's commonest values in the range with
 * their counts, as checkboxes that add filters.
 */
import type { FacetCount, LogFilters, LogStatsResponse } from '@ericminassian/platform-core';
import { fmtNum } from '../../format.ts';
import { cn } from '../../lib/utils.ts';
import { Checkbox } from '../ui/checkbox.tsx';
import { LEVEL_COLORS, streamLabel } from './log-table.tsx';

type FacetKey = 'levels' | 'streams' | 'routes' | 'status' | 'revs';

const FACETS: ReadonlyArray<{ key: FacetKey; stat: keyof LogStatsResponse['facets']; title: string }> = [
  { key: 'levels', stat: 'level', title: 'Level' },
  { key: 'streams', stat: 'stream', title: 'Stream' },
  { key: 'routes', stat: 'route', title: 'Route' },
  { key: 'status', stat: 'status', title: 'Status' },
  { key: 'revs', stat: 'rev', title: 'Deployment' },
];

const LEVEL_ORDER = ['error', 'warn', 'info', 'debug', 'system'];

/** The filters with `value` toggled in one list. */
export function toggleFilter(filters: LogFilters, key: FacetKey, value: string): LogFilters {
  const current: readonly string[] = filters[key] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const { [key]: _drop, ...rest } = filters;
  return next.length ? { ...rest, [key]: next } : rest;
}

function label(key: FacetKey, value: string): string {
  if (key === 'streams') return streamLabel(value);
  if (key === 'revs') return value.length > 14 ? value.slice(-7) : value;
  return value;
}

export function Facets({
  stats,
  filters,
  onChange,
}: {
  stats: LogStatsResponse | undefined;
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
}) {
  return (
    <div className="flex flex-col gap-5 px-4 py-3">
      {FACETS.map((facet) => {
        const counts: readonly FacetCount[] = stats?.facets[facet.stat] ?? [];
        const selected: readonly string[] = filters[facet.key] ?? [];
        // Picked values stay listed even when this range has none of them.
        const values = [
          ...counts,
          ...selected.filter((v) => !counts.some((c) => c.value === v)).map((value) => ({ value, count: 0 })),
        ];
        const ordered =
          facet.key === 'levels'
            ? values.toSorted((a, b) => LEVEL_ORDER.indexOf(a.value) - LEVEL_ORDER.indexOf(b.value))
            : values;
        // Without counts (loading, or a filter pattern search) only picked values are listed.
        if (ordered.length === 0 && (facet.key !== 'levels' || !stats)) return null;
        return (
          <fieldset key={facet.key} className="min-w-0">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{facet.title}</legend>
            {ordered.length === 0 && <p className="text-xs text-subtle">None in this range</p>}
            {ordered.map((c) => {
              const id = `facet-${facet.key}-${c.value}`;
              const checked = selected.includes(c.value);
              return (
                <label
                  key={c.value}
                  htmlFor={id}
                  className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-1 text-sm hover:bg-accent/60"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() => onChange(toggleFilter(filters, facet.key, c.value))}
                  />
                  {facet.key === 'levels' && (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ background: LEVEL_COLORS[c.value] }}
                    />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      facet.key !== 'levels' && 'font-mono text-[12px]',
                    )}
                    title={c.value}
                  >
                    {label(facet.key, c.value)}
                  </span>
                  <span className="text-xs text-muted-foreground tabular">{fmtNum(c.count)}</span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
