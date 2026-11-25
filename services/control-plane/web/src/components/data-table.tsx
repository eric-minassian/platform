/**
 * The console's tables (TanStack Table): sortable columns, numbers aligned
 * right, optional row actions. Pages define columns with `columns<Row>()`.
 */
import {
  type ColumnHelper,
  type RowData,
  createColumnHelper,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils.ts';
import { EmptyState } from './page.tsx';

declare module '@tanstack/react-table' {
  interface ColumnMeta<TFeatures, TData, TValue> {
    /** Right-aligns numbers so their digits line up. */
    readonly numeric?: boolean;
    readonly className?: string;
    readonly headerClassName?: string;
  }
}

export const tableFeatureSet = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    basic: sortFn_basic,
    alphanumeric: sortFn_alphanumeric,
    datetime: sortFn_datetime,
    // What string columns sort by when they name no `sortFn`.
    text: sortFn_text,
  },
});

export type TableFeatureSet = typeof tableFeatureSet;

/** A column helper for rows of type `Row`; `helper.columns([...])` builds a table's columns. */
export const columns = <Row extends RowData>() => createColumnHelper<TableFeatureSet, Row>();

/** A table's columns, of mixed value types. */
export type Columns<Row extends RowData> = ReturnType<ColumnHelper<TableFeatureSet, Row>['columns']>;

export function DataTable<Row extends RowData>({
  columns: defs,
  data,
  getRowId,
  initialSorting,
  onRowClick,
  isSelected,
  empty,
  className,
  dense = false,
}: {
  columns: Columns<Row>;
  data: readonly Row[];
  getRowId?: (row: Row, index: number) => string;
  initialSorting?: SortingState;
  onRowClick?: (row: Row) => void;
  isSelected?: (row: Row) => boolean;
  empty?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  const table = useTable({
    features: tableFeatureSet,
    columns: defs,
    data,
    ...(getRowId ? { getRowId } : {}),
    initialState: { sorting: initialSorting ?? [] },
  });
  const rows = table.getRowModel().rows;
  const cellY = dense ? 'py-1.5' : 'py-3';
  return (
    <div className={cn('min-w-0 overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b">
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta;
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    className={cn(
                      'h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5',
                      meta?.numeric ? 'text-right' : 'text-left',
                      meta?.headerClassName,
                    )}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          'inline-flex cursor-default items-center gap-1 rounded-sm outline-hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
                          meta?.numeric && 'flex-row-reverse',
                          sorted && 'text-foreground',
                        )}
                      >
                        <table.FlexRender header={header} />
                        {sorted === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <span className="size-3" />
                        )}
                      </button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              data-selected={isSelected?.(row.original) || undefined}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
              // A clickable row also opens from the keyboard; controls inside it keep their own keys.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                      e.preventDefault();
                      onRowClick(row.original);
                    }
                  : undefined
              }
              className={cn(
                'border-b transition-colors last:border-0 data-selected:bg-accent',
                onRowClick &&
                  'cursor-pointer outline-hidden hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
              )}
            >
              {row.getAllCells().map((cell) => {
                const meta = cell.column.columnDef.meta;
                return (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-3 align-middle first:pl-5 last:pr-5',
                      cellY,
                      meta?.numeric && 'text-right tabular',
                      meta?.className,
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (empty ?? <EmptyState title="Nothing here yet" />)}
    </div>
  );
}
