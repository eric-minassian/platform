/**
 * A read-only look at an app stage's table: its collections with sampled
 * item counts, and a collection's items a page at a time, optionally within
 * one partition, each item's whole record in a side sheet. The collection
 * and partition are in the URL, so a view can be linked to.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { DataCollections } from '@ericminassian/platform-core';
import { AsyncResult } from 'effect/reactivity';
import { Copy, Search, X } from 'lucide-react';
import { type ReactElement, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiClient, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import { EmptyState, ErrorNotice, Loaded, Loading, Mono, PageHeader, Panel } from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '../../components/ui/input-group.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../../components/ui/sheet.tsx';
import { family } from '../../data/atoms.ts';
import { fmtNum } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { appRoute, databaseRoute } from '../../router.tsx';

const collectionsAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('manage', 'collections', {
      params: { app: k.app },
      query: { stage: k.stage },
      timeToLive,
    }),
  ),
);
const itemPages = family((k: { app: string; stage: string; collection: string; partition: string }) =>
  pages(
    (cursor) =>
      ApiClient.use((client) =>
        client.manage.items({
          params: { app: k.app },
          query: { stage: k.stage, collection: k.collection, partition: k.partition || undefined, cursor },
        }),
      ),
    (page) => page.cursor,
  ),
);

type Item = Readonly<Record<string, unknown>>;

/** Columns shown in the table; the sheet shows the rest. */
const MAX_COLUMNS = 6;

export function DatabasePage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const search = databaseRoute.useSearch();
  const result = useAtomValue(collectionsAtom({ app, stage }));
  return (
    <>
      <PageHeader title="Database" description={`Read-only view of ${stage}'s table.`} />
      <Loaded result={result}>
        {(d) =>
          !d.database ? (
            <Panel>
              <EmptyState title={`No database on ${stage}`}>
                Turn on <Mono>db</Mono> in <Mono>plat.config.ts</Mono> and deploy to give the app a table.
              </EmptyState>
            </Panel>
          ) : d.collections.length === 0 ? (
            <Panel>
              <EmptyState title="No data yet">
                Collections appear once the app writes its first item.
              </EmptyState>
            </Panel>
          ) : (
            <Browser
              app={app}
              stage={stage}
              collections={d.collections}
              collection={
                d.collections.find((c) => c.name === search.collection)?.name ?? d.collections[0]!.name
              }
              partition={search.partition ?? ''}
            />
          )
        }
      </Loaded>
    </>
  );
}

function Browser({
  app,
  stage,
  collections,
  collection,
  partition,
}: {
  app: string;
  stage: string;
  collections: DataCollections['collections'];
  collection: string;
  partition: string;
}) {
  const navigate = databaseRoute.useNavigate();
  const pick = (name: string) =>
    void navigate({ search: (prev) => ({ ...prev, collection: name, partition: undefined }) });
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Panel flush title="Collections" description="Counts from a sample of the table">
        <ul className="px-2 pb-1">
          {collections.map((c) => (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => pick(c.name)}
                aria-current={c.name === collection || undefined}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  c.name === collection && 'bg-accent font-medium',
                )}
              >
                <Mono className="truncate">{c.name}</Mono>
                <span
                  className="text-xs text-muted-foreground tabular"
                  title="Sampled; large collections are undercounted"
                >
                  {fmtNum(c.sampled)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <Items
        key={`${collection}\u0000${partition}`}
        app={app}
        stage={stage}
        collection={collection}
        partition={partition}
      />
    </div>
  );
}

function Items({
  app,
  stage,
  collection,
  partition,
}: {
  app: string;
  stage: string;
  collection: string;
  partition: string;
}) {
  const navigate = databaseRoute.useNavigate();
  const atom = itemPages({ app, stage, collection, partition });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const loaded = loadedPages(result);
  const rows = useMemo(() => loaded.flatMap((p) => p.items), [loaded]);
  const more = loaded.at(-1)?.cursor !== undefined;
  const [draft, setDraft] = useState(partition);
  const [open, setOpen] = useState<Item>();
  const tableColumns = useMemo(() => itemColumns(rows), [rows]);
  const apply = (value: string) =>
    void navigate({ search: (prev) => ({ ...prev, partition: value.trim() || undefined }) });
  return (
    <Panel
      flush
      title={<Mono className="text-sm">{collection}</Mono>}
      description={
        AsyncResult.isInitial(result)
          ? undefined
          : `${fmtNum(rows.length)} ${rows.length === 1 ? 'item' : 'items'} loaded${more ? ', more to load' : ''}`
      }
      actions={
        <form
          className="w-72"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
          }}
        >
          <InputGroup className="h-8">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Partition key value"
              placeholder="Partition key value"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            {partition && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Clear partition"
                  onClick={() => {
                    setDraft('');
                    apply('');
                  }}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </form>
      }
    >
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="mx-4 mb-3" />}
      {AsyncResult.isInitial(result) ? (
        <Loading rows={6} />
      ) : (
        <DataTable
          columns={tableColumns}
          data={rows}
          getRowId={(item, i) => keyOf(item) ?? String(i)}
          onRowClick={setOpen}
          isSelected={(item) => item === open}
          dense
          empty={
            <EmptyState title={partition ? 'No items in this partition' : 'No items'}>
              {partition && (
                <>
                  Nothing in <Mono>{collection}</Mono> has the partition key <Mono>{partition}</Mono>.
                </>
              )}
            </EmptyState>
          }
        />
      )}
      {more && (
        <div className="border-t px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={() => loadMore()} disabled={result.waiting}>
            {result.waiting ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      <ItemSheet collection={collection} item={open} onOpenChange={(o) => !o && setOpen(undefined)} />
    </Panel>
  );
}

/** The item's table key (`_key`, `{ pk, sk }`), which the browser adds to every record. */
function keyOf(item: Item): string | undefined {
  return item._key === undefined ? undefined : JSON.stringify(item._key);
}

/** The first fields in the order items have them, up to `MAX_COLUMNS`. */
function fieldsOf(rows: readonly Item[]): string[] {
  const fields: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (key === '_key' || fields.includes(key)) continue;
      fields.push(key);
      if (fields.length === MAX_COLUMNS) return fields;
    }
  }
  return fields;
}

const item = columns<Item>();

/**
 * One column per common field. A page of items isn't the whole collection,
 * so the columns don't sort: an order would only hold for what's loaded.
 */
function itemColumns(rows: readonly Item[]) {
  return item.columns(
    fieldsOf(rows).map((field) => {
      const present = rows.map((row) => row[field]).filter((v) => v !== undefined && v !== null);
      const numeric = present.length > 0 && present.every((v) => typeof v === 'number');
      return item.accessor((row) => row[field], {
        id: field,
        header: () => <span className="font-mono">{field}</span>,
        enableSorting: false,
        meta: { numeric, className: 'max-w-72' },
        cell: ({ getValue }) => <Value value={getValue()} />,
      });
    }),
  );
}

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-subtle">–</span>;
  if (value === null) return <Mono className="text-muted-foreground">null</Mono>;
  if (typeof value === 'string') return <span className="block truncate">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean')
    return <Mono className="tabular">{String(value)}</Mono>;
  return <Mono className="block truncate text-muted-foreground">{JSON.stringify(value)}</Mono>;
}

function ItemSheet({
  collection,
  item: it,
  onOpenChange,
}: {
  collection: string;
  item: Item | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const body = useRef<HTMLPreElement>(null);
  const json = it ? JSON.stringify(it, null, 2) : '';
  const key = it?._key as { pk?: unknown; sk?: unknown } | undefined;
  return (
    <Sheet open={it !== undefined} onOpenChange={onOpenChange}>
      <SheetContent initialFocus={body} className="w-full gap-0 data-[side=right]:sm:max-w-xl">
        {it && (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle className="font-mono">{collection}</SheetTitle>
              <SheetDescription className="truncate font-mono text-xs">
                {key ? `${String(key.pk)} · ${String(key.sk)}` : 'An item'}
              </SheetDescription>
            </SheetHeader>
            <div className="flex items-center justify-end border-b px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void navigator.clipboard.writeText(json).then(
                    () => toast.success('Copied the item as JSON'),
                    () => toast.error("Couldn't copy to the clipboard"),
                  )
                }
              >
                <Copy />
                Copy JSON
              </Button>
            </div>
            <pre
              ref={body}
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed outline-none"
            >
              {json}
            </pre>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
