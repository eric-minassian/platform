/**
 * A read-only look at an app stage's file stores: a store's files under a
 * prefix, a page at a time, with their sizes and dates and a short-lived
 * download link for each. Listings are flat (no folders on the server), so
 * the prefix is how you browse: the folders in a key narrow to that folder.
 * The store and prefix are in the URL, so a view can be linked to.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { StoredObjectInfo } from '@ericminassian/platform-core';
import { Link } from '@tanstack/react-router';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { Download, Search } from 'lucide-react';
import { Fragment, type ReactElement, type ReactNode, useCallback, useMemo, useState } from 'react';
import { ApiClient, errorMessage, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import { columns, DataTable } from '../../components/data-table.tsx';
import {
  EmptyState,
  ErrorNotice,
  Loaded,
  Loading,
  Mono,
  PageHeader,
  Panel,
  StatusPill,
} from '../../components/page.tsx';
import { Button } from '../../components/ui/button.tsx';
import { InputClear, InputGroup, InputGroupAddon, InputGroupInput } from '../../components/ui/input.tsx';
import { toast } from '../../components/ui/overlays.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import { Tip } from '../../components/ui/tooltip.tsx';
import { family } from '../../data/atoms.ts';
import { fmtBytes, fmtDateTime, fmtNum, relTime } from '../../format.ts';
import { useStage } from '../../lib/hooks.ts';
import { cn } from '../../lib/utils.ts';
import { appRoute, storageRoute } from '../../router.tsx';

const storesAtom = family((k: { app: string; stage: string }) =>
  fresh(
    ApiClient.query('manage', 'storage', { params: { app: k.app }, query: { stage: k.stage }, timeToLive }),
  ),
);
const objectPages = family((k: { app: string; stage: string; store: string; prefix: string }) =>
  pages(
    (cursor) =>
      ApiClient.use((client) =>
        client.manage.storage({
          params: { app: k.app },
          query: { stage: k.stage, store: k.store, prefix: k.prefix || undefined, cursor },
        }),
      ),
    // With `store`, the endpoint answers a listing.
    (page) => ('objects' in page ? page.cursor : undefined),
  ),
);
const objectUrlAtom = ApiClient.mutation('manage', 'storageUrl');

export function StoragePage(): ReactElement {
  const { app } = appRoute.useParams();
  const stage = useStage();
  const search = storageRoute.useSearch();
  const result = useAtomValue(storesAtom({ app, stage }));
  return (
    <>
      <PageHeader title="Storage" description={`Read-only view of ${stage}'s file stores.`} />
      <Loaded result={result}>
        {(r) => {
          // Without `store`, the endpoint answers the declared stores.
          const stores = 'stores' in r ? r.stores : [];
          const served = 'stores' in r ? (r.public ?? []) : [];
          if (stores.length === 0) {
            return (
              <Panel>
                <EmptyState title={`No storage on ${stage}`}>
                  Declare a store under <Mono>storage</Mono> in <Mono>plat.config.ts</Mono> to keep files.
                </EmptyState>
              </Panel>
            );
          }
          const store = stores.includes(search.store ?? '') ? search.store! : stores[0]!;
          return (
            <Objects
              key={`${store}\u0000${search.prefix ?? ''}`}
              app={app}
              stage={stage}
              stores={stores}
              served={served}
              store={store}
              prefix={search.prefix ?? ''}
            />
          );
        }}
      </Loaded>
    </>
  );
}

function Objects({
  app,
  stage,
  stores,
  served,
  store,
  prefix,
}: {
  app: string;
  stage: string;
  stores: readonly string[];
  served: readonly string[];
  store: string;
  prefix: string;
}) {
  const navigate = storageRoute.useNavigate();
  const atom = objectPages({ app, stage, store, prefix });
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const objectUrl = useAtomSet(objectUrlAtom, { mode: 'promiseExit' });
  const [draft, setDraft] = useState(prefix);
  const loaded = loadedPages(result);
  const objects = useMemo(() => loaded.flatMap((page) => ('objects' in page ? page.objects : [])), [loaded]);
  const last = loaded.at(-1);
  const more = last !== undefined && 'objects' in last && last.cursor !== undefined;
  const bytes = objects.reduce((n, o) => n + o.size, 0);

  const go = useCallback(
    (next: { store?: string; prefix: string }) =>
      void navigate({
        search: (prev) => ({ ...prev, store: next.store ?? prev.store, prefix: next.prefix || undefined }),
      }),
    [navigate],
  );
  const tableColumns = useMemo(() => {
    const download = async (key: string) => {
      const exit = await objectUrl({ params: { app }, query: { stage, store, key } });
      if (Exit.isSuccess(exit)) window.open(exit.value.url, '_blank', 'noopener');
      else toast.error(errorMessage(exit.cause));
    };
    return objectColumns(app, prefix, (key) => void download(key));
  }, [prefix, app, stage, store, objectUrl]);

  return (
    <Panel
      flush
      title={
        <span className="flex items-center gap-2">
          <Mono className="text-sm">{store}</Mono>
          {/* The edge serves these to anyone with the URL. */}
          {served.includes(store) && <StatusPill tone="info">Public</StatusPill>}
        </span>
      }
      description={
        AsyncResult.isInitial(result)
          ? undefined
          : `${fmtNum(objects.length)} ${objects.length === 1 ? 'file' : 'files'} loaded, ${fmtBytes(bytes)}${more ? ', more to load' : ''}`
      }
      actions={
        <>
          {stores.length > 1 && (
            <Select
              value={store}
              onValueChange={(v) => typeof v === 'string' && go({ store: v, prefix: '' })}
            >
              <SelectTrigger className="min-w-36 font-mono text-[13px]" aria-label="Store">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stores.map((s) => (
                  <SelectItem key={s} value={s} label={s}>
                    <span className="font-mono text-[13px]">{s}</span>
                    {served.includes(s) && <span className="ml-auto text-xs text-subtle">public</span>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <form
            className="w-64"
            onSubmit={(e) => {
              e.preventDefault();
              go({ prefix: draft.trim() });
            }}
          >
            <InputGroup>
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Key prefix"
                className="font-mono text-[13px] placeholder:font-sans placeholder:text-sm"
                placeholder="Key prefix, e.g. uploads/"
                spellCheck={false}
                value={draft}
                onValueChange={(value, details) => {
                  setDraft(value);
                  if (details.reason === 'clear-press') go({ prefix: '' });
                }}
              />
              <InputClear label="Clear prefix" />
            </InputGroup>
          </form>
        </>
      }
    >
      {prefix && <PrefixPath app={app} prefix={prefix} />}
      {result._tag === 'Failure' && <ErrorNotice error={result.cause} className="mx-5 mb-3" />}
      {AsyncResult.isInitial(result) ? (
        <Loading rows={6} />
      ) : (
        <DataTable
          columns={tableColumns}
          data={objects}
          getRowId={(o) => o.key}
          dense
          empty={
            <EmptyState title={prefix ? 'No files under this prefix' : 'No files yet'}>
              {prefix && (
                <>
                  Nothing in <Mono>{store}</Mono> starts with <Mono>{prefix}</Mono>.
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
    </Panel>
  );
}

/** A link to the listing under `prefix`, keeping the store and the rest of the URL. */
function PrefixLink({
  app,
  prefix,
  className,
  children,
}: {
  app: string;
  prefix: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/apps/$app/storage"
      params={{ app }}
      search={(prev) => ({ ...prev, prefix: prefix || undefined })}
      className={cn(
        'rounded-sm text-muted-foreground outline-hidden hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** The prefix as a path: each folder in it narrows back out to that folder. */
function PrefixPath({ app, prefix }: { app: string; prefix: string }) {
  const parts = prefix.split('/');
  return (
    <nav
      aria-label="Prefix"
      className="flex flex-wrap items-center gap-1 border-b px-5 pb-3 font-mono text-xs"
    >
      <PrefixLink app={app} prefix="">
        all files
      </PrefixLink>
      {parts.map((part, i) => {
        if (part === '' && i === parts.length - 1) return null;
        const to = `${parts.slice(0, i + 1).join('/')}${i < parts.length - 1 ? '/' : ''}`;
        const current = i >= parts.length - 2 && to === prefix;
        return (
          <Fragment key={to}>
            <span className="text-subtle">/</span>
            {current ? (
              <span aria-current="location">{part}</span>
            ) : (
              <PrefixLink app={app} prefix={to}>
                {part}
              </PrefixLink>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

const object = columns<StoredObjectInfo>();

function objectColumns(app: string, prefix: string, onDownload: (key: string) => void) {
  return object.columns([
    object.accessor('key', {
      header: 'Key',
      sortFn: 'alphanumeric',
      meta: { className: 'max-w-[40rem]' },
      cell: ({ getValue }) => <KeyPath app={app} fullKey={getValue()} prefix={prefix} />,
    }),
    object.accessor('size', {
      header: 'Size',
      meta: { numeric: true },
      cell: ({ getValue }) => fmtBytes(getValue()),
    }),
    object.accessor((o) => o.lastModified ?? '', {
      id: 'modified',
      header: 'Modified',
      meta: { numeric: true },
      cell: ({ row }) =>
        row.original.lastModified ? (
          <span className="whitespace-nowrap" title={fmtDateTime(row.original.lastModified)}>
            {relTime(row.original.lastModified)}
          </span>
        ) : (
          '–'
        ),
    }),
    object.display({
      id: 'download',
      header: () => <span className="sr-only">Download</span>,
      meta: { className: 'w-0 text-right' },
      cell: ({ row }) => (
        <Tip label="Download">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Download ${row.original.key}`}
            onClick={() => onDownload(row.original.key)}
          >
            <Download />
          </Button>
        </Tip>
      ),
    }),
  ]);
}

/** A key below the prefix, its folders links that narrow the listing to them. */
function KeyPath({ app, fullKey, prefix }: { app: string; fullKey: string; prefix: string }) {
  const rest = fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;
  const base = fullKey.startsWith(prefix) ? prefix : '';
  const parts = rest.split('/');
  const name = parts.pop() ?? '';
  return (
    <span className="flex min-w-0 items-baseline font-mono text-[13px]">
      {parts.map((folder, i) => {
        const to = `${base}${parts.slice(0, i + 1).join('/')}/`;
        return (
          <Fragment key={to}>
            <PrefixLink app={app} prefix={to} className="shrink-0">
              {folder}
            </PrefixLink>
            <span className="text-subtle">/</span>
          </Fragment>
        );
      })}
      <span className="truncate">{name}</span>
    </span>
  );
}
