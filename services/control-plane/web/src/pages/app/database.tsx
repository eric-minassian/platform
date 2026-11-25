/**
 * A read-only look at an app stage's table: its collections with sampled
 * item counts, and a collection's items a page at a time, optionally within
 * one partition, each item's key and whole record in a side panel. The
 * collection and partition are in the URL, so a view can be linked to.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { DataCollections } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { AsyncResult } from 'effect/reactivity';
import { Copy, PanelRightOpen, Search } from 'lucide-react';
import { type ReactElement, useMemo, useState } from 'react';
import { ApiClient, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  ErrorNotice,
  Fact,
  Facts,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '../../components/ui/drawer.tsx';
import { InputClear, InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input.tsx';
import { toast } from '../../components/ui/overlays.tsx';
import { Tip } from '../../components/ui/tooltip.tsx';
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

/** Columns shown in the table; the side panel shows the rest. */
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
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Panel flush title="Collections" description="Item counts from a sample">
        <ul className="flex flex-col gap-px px-2 pb-1">
          {collections.map((c) => {
            const current = c.name === collection;
            return (
              <li key={c.name}>
                <Link
                  to="/apps/$app/database"
                  params={{ app }}
                  search={(prev) => ({ ...prev, collection: c.name, partition: undefined })}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center justify-between gap-3 rounded-md px-3 text-sm text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    current && 'bg-accent font-medium text-foreground',
                  )}
                >
                  <Mono className="truncate">{c.name}</Mono>
                  <span
                    className="text-xs text-subtle tabular"
                    title="Sampled; large collections are undercounted"
                  >
                    {fmtNum(c.sampled)}
                  </span>
                </Link>
              </li>
            );
          })}
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
  const tableColumns = useMemo(() => itemColumns(rows, setOpen), [rows]);
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
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Partition key value"
              className="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
              placeholder="Partition key value"
              spellCheck={false}
              value={draft}
              onValueChange={(value, details) => {
                setDraft(value);
                if (details.reason === 'clear-press') apply('');
              }}
            />
            <InputClear label="Clear partition" />
          </InputGroup>
        </form>
      }
    >
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="mx-5 mb-3" />}
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
        <div className="border-t px-5 py-2.5">
          <Button variant="outline" size="sm" onClick={() => loadMore()} disabled={result.waiting}>
            {result.waiting ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      <ItemDrawer collection={collection} item={open} onOpenChange={(o) => !o && setOpen(undefined)} />
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

const itemColumn = columns<Item>();

/**
 * One column per common field. A page of items isn't the whole collection,
 * so the columns don't sort: an order would only hold for what's loaded.
 */
function itemColumns(rows: readonly Item[], onOpen: (item: Item) => void) {
  const fields = fieldsOf(rows);
  // The row's first field names it, the way the table shows it.
  const nameOf = (item: Item) => {
    const first = fields[0] === undefined ? undefined : item[fields[0]];
    if (typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean')
      return String(first);
    return first === undefined || first === null ? 'item' : JSON.stringify(first);
  };
  return itemColumn.columns([
    ...fields.map((field) => {
      const present = rows.map((row) => row[field]).filter((v) => v !== undefined && v !== null);
      const numeric = present.length > 0 && present.every((v) => typeof v === 'number');
      return itemColumn.accessor((row) => row[field], {
        id: field,
        header: () => <span className="font-mono">{field}</span>,
        enableSorting: false,
        meta: { numeric, className: 'max-w-72' },
        cell: ({ getValue }) => <Value value={getValue()} />,
      });
    }),
    itemColumn.display({
      id: 'open',
      header: () => <span className="sr-only">Open</span>,
      meta: { className: 'w-0' },
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Open ${nameOf(row.original)}`}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(row.original);
          }}
        >
          <PanelRightOpen />
        </Button>
      ),
    }),
  ]);
}

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-subtle">–</span>;
  if (value === null) return <Mono className="text-muted-foreground">null</Mono>;
  if (typeof value === 'string') return <span className="block truncate">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean')
    return <Mono className="tabular">{String(value)}</Mono>;
  return <Mono className="block truncate text-muted-foreground">{JSON.stringify(value)}</Mono>;
}

/** Copies text to the clipboard and says whether it worked. */
function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${what}`),
    () => toast.error("Couldn't copy to the clipboard"),
  );
}

function ItemDrawer({
  collection,
  item,
  onOpenChange,
}: {
  collection: string;
  item: Item | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  // The item stays on screen while the panel slides out.
  const [kept, setKept] = useState(item);
  if (item && item !== kept) setKept(item);
  const it = item ?? kept;
  const key = it?._key as { pk?: unknown; sk?: unknown } | undefined;
  // `_key` is the browser's addition; the record is everything else.
  const json = useMemo(() => {
    if (!it) return '';
    const { _key, ...record } = it;
    return JSON.stringify(record, null, 2);
  }, [it]);
  return (
    <Drawer open={item !== undefined} onOpenChange={onOpenChange}>
      <DrawerContent width="36rem" initialFocus="content">
        {it && (
          <>
            <DrawerHeader>
              <DrawerTitle className="font-mono">{collection}</DrawerTitle>
              <DrawerDescription className="font-mono text-[13px]">
                {key ? `${String(key.pk)} · ${String(key.sk)}` : `${Object.keys(it).length} fields`}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="flex flex-col gap-6">
              {key && (
                <section className="flex flex-col gap-3">
                  <h3 className="text-[13px] font-medium">Key</h3>
                  <Facts className="items-center">
                    <Fact label="Partition key">
                      <KeyValue label="partition key" value={String(key.pk)} />
                    </Fact>
                    <Fact label="Sort key">
                      <KeyValue label="sort key" value={String(key.sk)} />
                    </Fact>
                  </Facts>
                </section>
              )}
              <section className="flex min-h-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[13px] font-medium">Item</h3>
                  <Button variant="outline" size="sm" onClick={() => copy(json, 'the item as JSON')}>
                    <Copy />
                    Copy JSON
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-lg border bg-muted p-4 font-mono text-xs leading-relaxed">
                  {json}
                </pre>
              </section>
            </DrawerBody>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Mono className="min-w-0 break-all">{value}</Mono>
      <Tip label={`Copy ${label}`}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy ${label}`}
          onClick={() => copy(value, `the ${label}`)}
        >
          <Copy />
        </Button>
      </Tip>
    </span>
  );
}
