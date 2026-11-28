/**
 * The log page's facets: each field's commonest values in the range with
 * their counts, as checkboxes that add filters.
 */
import type { FacetCount, LogFilters, LogStatsResponse } from '@ericminassian/platform-core';
import type { ReactNode } from 'react';
import { fmtNum, shortId } from '../../format.ts';
import { cn } from '../../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Checkbox } from '../ui/checkbox.tsx';
import { LEVEL_COLORS } from './log-table.tsx';

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
  if (key === 'revs') return shortId(value);
  return value;
}

function Option({
  id,
  checked,
  onChange,
  title,
  children,
  count,
}: {
  id: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  children: ReactNode;
  count?: number;
}) {
  return (
    <label
      htmlFor={id}
      className="-mx-1.5 flex h-7 cursor-default items-center gap-2 rounded-md px-1.5 text-[13px] hover:bg-muted"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-description={count === undefined ? undefined : `${fmtNum(count)} lines`}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2" title={title}>
        {children}
      </span>
      {count !== undefined && (
        <span aria-hidden className="text-xs text-muted-foreground tabular">
          {fmtNum(count)}
        </span>
      )}
    </label>
  );
}

export function Facets({
  stats,
  filters,
  onChange,
  note,
}: {
  stats: LogStatsResponse | undefined;
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  /** Said above the facets, e.g. why there are no counts. */
  note?: string;
}) {
  const filtered = Object.values(filters).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
  return (
    <div className="flex flex-col gap-5">
      <header className="flex h-7 items-center justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        {filtered && (
          <Button variant="ghost" size="xs" onClick={() => onChange({})}>
            Clear
          </Button>
        )}
      </header>
      {note && <p className="-mt-3 text-xs text-muted-foreground">{note}</p>}
      {filters.trace && (
        <fieldset className="min-w-0">
          <legend className="mb-1 text-xs font-medium text-muted-foreground">Trace</legend>
          <Option
            id="facet-trace"
            checked
            title={filters.trace}
            onChange={() => {
              const { trace: _drop, ...rest } = filters;
              onChange(rest);
            }}
          >
            <span className="truncate font-mono text-[12px]">{filters.trace}</span>
          </Option>
        </fieldset>
      )}
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
            <legend className="mb-1 text-xs font-medium text-muted-foreground">{facet.title}</legend>
            {ordered.length === 0 && <p className="text-xs text-subtle">None in this range</p>}
            {ordered.map((c) => (
              <Option
                key={c.value}
                id={`facet-${facet.key}-${c.value}`}
                checked={selected.includes(c.value)}
                onChange={() => onChange(toggleFilter(filters, facet.key, c.value))}
                title={c.value}
                {...(stats ? { count: c.count } : {})}
              >
                {facet.key === 'levels' && (
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: LEVEL_COLORS[c.value] }}
                  />
                )}
                <span className={cn('truncate', facet.key !== 'levels' && 'font-mono text-[12px]')}>
                  {label(facet.key, c.value)}
                </span>
              </Option>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}
