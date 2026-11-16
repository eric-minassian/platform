import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Exit, Option } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useState } from 'react';
import { ApiClient, fresh, loadedPages, pages, timeToLive } from '../../client.ts';
import {
  Button,
  Card,
  cx,
  Empty,
  ErrorBox,
  Input,
  Loaded,
  Mono,
  Select,
  Spinner,
  Table,
} from '../../components/ui.tsx';
import { fmtBytes, relTime } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

const collectionsAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(ApiClient.query('manage', 'collections', { params: { app }, query: { stage }, timeToLive })),
);
const itemPages = Atom.family(
  ({
    app,
    stage,
    collection,
    partition,
  }: {
    app: string;
    stage: string;
    collection: string;
    partition: string;
  }) =>
    pages(
      (cursor) =>
        ApiClient.use((client) =>
          client.manage.items({
            params: { app },
            query: { stage, collection, partition: partition || undefined, cursor },
          }),
        ),
      (page) => page.cursor,
    ),
);
const storesAtom = Atom.family(({ app, stage }: { app: string; stage: string }) =>
  fresh(ApiClient.query('manage', 'storage', { params: { app }, query: { stage }, timeToLive })),
);
const objectPages = Atom.family(({ app, stage, store }: { app: string; stage: string; store: string }) =>
  pages(
    (cursor) =>
      ApiClient.use((client) => client.manage.storage({ params: { app }, query: { stage, store, cursor } })),
    // With `store`, the endpoint answers a listing.
    (page) => ('objects' in page ? page.cursor : undefined),
  ),
);
const objectUrlAtom = ApiClient.mutation('manage', 'storageUrl');

function Items(key: { app: string; stage: string; collection: string; partition: string }) {
  const atom = itemPages(key);
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const loaded = loadedPages(result);
  const rows = loaded.flatMap((p) => p.items);
  return (
    <>
      <ErrorBox error={result._tag === 'Failure' ? result.cause : undefined} />
      {AsyncResult.isInitial(result) ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Empty>No items.</Empty>
      ) : (
        <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
          {rows.map((item) => (
            <pre
              key={JSON.stringify(item._key)}
              className="overflow-x-auto rounded-md bg-panel-2 p-2 font-mono text-[11px]"
            >
              {JSON.stringify(item, null, 2)}
            </pre>
          ))}
        </div>
      )}
      {loaded.at(-1)?.cursor !== undefined && (
        <Button onClick={() => loadMore()} disabled={result.waiting}>
          Load more
        </Button>
      )}
    </>
  );
}

function Collections() {
  const { app, scope } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [partition, setPartition] = useState('');
  const [applied, setApplied] = useState('');
  const collections = useAtomValue(collectionsAtom({ app, stage: scope.stage }));

  return (
    <Card title="Database">
      <Loaded result={collections}>
        {(d) =>
          !d.database ? (
            <Empty>No database declared in plat.config.ts.</Empty>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
              <div>
                {d.collections.length === 0 ? (
                  <Empty>No data yet.</Empty>
                ) : (
                  <ul className="space-y-0.5">
                    {d.collections.map((c) => (
                      <li key={c.name}>
                        <button
                          type="button"
                          onClick={() => setSelected(c.name)}
                          className={cx(
                            'flex w-full justify-between rounded px-2 py-1 text-left text-[12px] hover:bg-panel-2',
                            selected === c.name && 'bg-panel-2 font-medium',
                          )}
                        >
                          <Mono>{c.name}</Mono>
                          <span className="text-muted">{c.sampled}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="min-w-0">
                {!selected ? (
                  <Empty>Pick a collection.</Empty>
                ) : (
                  <div className="space-y-2">
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setApplied(partition.trim());
                      }}
                    >
                      <Input
                        value={partition}
                        onChange={(e) => setPartition(e.target.value)}
                        placeholder="partition key value (optional)"
                        className="w-72"
                      />
                      <Button type="submit">Filter</Button>
                    </form>
                    <Items app={app} stage={scope.stage} collection={selected} partition={applied} />
                  </div>
                )}
              </div>
            </div>
          )
        }
      </Loaded>
    </Card>
  );
}

function Objects(key: { app: string; stage: string; store: string }) {
  const atom = objectPages(key);
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const objectUrl = useAtomSet(objectUrlAtom, { mode: 'promiseExit' });
  const download = async (objectKey: string) => {
    const exit = await objectUrl({
      params: { app: key.app },
      query: { stage: key.stage, store: key.store, key: objectKey },
    });
    if (Exit.isSuccess(exit)) window.open(exit.value.url, '_blank', 'noopener');
  };
  if (AsyncResult.isInitial(result)) return <Spinner />;
  const loaded = loadedPages(result);
  const failed = result._tag === 'Failure' ? <ErrorBox error={result.cause} /> : null;
  if (loaded.length === 0) return failed;
  const last = loaded.at(-1);
  return (
    <>
      {failed}
      <Table head={['Key', 'Size', 'Modified', '']} empty="No files.">
        {loaded.flatMap((page) =>
          'objects' in page
            ? page.objects.map((obj) => (
                <tr key={obj.key}>
                  <td>
                    <Mono>{obj.key}</Mono>
                  </td>
                  <td className="tabular-nums">{fmtBytes(obj.size)}</td>
                  <td>{relTime(obj.lastModified)}</td>
                  <td className="text-right">
                    <Button variant="ghost" onClick={() => void download(obj.key)}>
                      Download
                    </Button>
                  </td>
                </tr>
              ))
            : [],
        )}
      </Table>
      {last !== undefined && 'objects' in last && last.cursor !== undefined && (
        <div className="pt-2">
          <Button onClick={() => loadMore()} disabled={result.waiting}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

function Storage() {
  const { app, scope } = useApp();
  const stores = useAtomValue(storesAtom({ app, stage: scope.stage }));
  // Without `store`, the endpoint answers the declared stores.
  const none: { readonly stores: ReadonlyArray<string>; readonly public: ReadonlyArray<string> } = {
    stores: [],
    public: [],
  };
  const listed = Option.match(AsyncResult.value(stores), {
    onNone: () => none,
    onSome: (r) => ('stores' in r ? { stores: r.stores, public: r.public ?? [] } : none),
  });
  const declared = listed.stores;
  const [store, setStore] = useState('');
  const active = store || declared[0] || '';
  return (
    <Card
      title="Storage"
      actions={
        declared.length > 0 ? (
          <Select
            value={active}
            onChange={setStore}
            options={declared.map((s) => ({
              value: s,
              // The edge serves these to anyone with the URL.
              label: listed.public.includes(s) ? `${s} (public)` : s,
            }))}
          />
        ) : null
      }
    >
      {!active ? (
        <Empty>No storage declared in plat.config.ts.</Empty>
      ) : (
        <Objects app={app} stage={scope.stage} store={active} />
      )}
    </Card>
  );
}

export function DataTab() {
  return (
    <div className="space-y-3">
      <Collections />
      <Storage />
    </div>
  );
}
