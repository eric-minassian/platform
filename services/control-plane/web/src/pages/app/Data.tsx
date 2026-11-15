import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api.ts';
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

function Collections() {
  const { app, scope } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [partition, setPartition] = useState('');
  const [applied, setApplied] = useState('');
  const collections = useQuery({
    queryKey: ['collections', app, scope.stage],
    queryFn: () => api.collections(app, scope.stage),
  });
  const items = useInfiniteQuery({
    queryKey: ['items', app, scope.stage, selected, applied],
    queryFn: ({ pageParam }) =>
      api.items(app, scope.stage, selected!, applied || undefined, pageParam || undefined),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.cursor,
    enabled: Boolean(selected),
  });
  const rows = items.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card title="Database">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_minmax(0,1fr)]">
        <div>
          <Loaded q={collections}>
            {(cs) =>
              cs.length === 0 ? (
                <Empty>No data yet.</Empty>
              ) : (
                <ul className="space-y-0.5">
                  {cs.map((c) => (
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
              )
            }
          </Loaded>
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
              <ErrorBox error={items.error} />
              {items.isPending ? (
                <Spinner />
              ) : rows.length === 0 ? (
                <Empty>No items.</Empty>
              ) : (
                <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
                  {rows.map((item, i) => (
                    <pre
                      // biome-ignore lint/suspicious/noArrayIndexKey: items are displayed in scan order
                      key={i}
                      className="overflow-x-auto rounded-md bg-panel-2 p-2 font-mono text-[11px]"
                    >
                      {JSON.stringify(item, null, 2)}
                    </pre>
                  ))}
                </div>
              )}
              {items.hasNextPage && (
                <Button onClick={() => items.fetchNextPage()} disabled={items.isFetchingNextPage}>
                  Load more
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function Storage() {
  const { app, scope } = useApp();
  const stores = useQuery({
    queryKey: ['stores', app, scope.stage],
    queryFn: () => api.stores(app, scope.stage),
  });
  const [store, setStore] = useState('');
  const active = store || stores.data?.stores[0] || '';
  const objects = useQuery({
    queryKey: ['objects', app, scope.stage, active],
    queryFn: () => api.objects(app, scope.stage, active),
    enabled: Boolean(active),
  });
  return (
    <Card
      title="Storage"
      actions={
        stores.data && stores.data.stores.length > 0 ? (
          <Select
            value={active}
            onChange={setStore}
            options={stores.data.stores.map((s) => ({ value: s, label: s }))}
          />
        ) : null
      }
    >
      {!active ? (
        <Empty>No storage declared in plat.config.ts.</Empty>
      ) : (
        <Loaded q={objects}>
          {(o) => (
            <Table head={['Key', 'Size', 'Modified', '']} empty="No files.">
              {o.objects.map((obj) => (
                <tr key={obj.key}>
                  <td>
                    <Mono>{obj.key}</Mono>
                  </td>
                  <td className="tabular-nums">{fmtBytes(obj.size)}</td>
                  <td>{relTime(obj.lastModified)}</td>
                  <td className="text-right">
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        const { url } = await api.objectUrl(app, scope.stage, active, obj.key);
                        window.open(url, '_blank', 'noopener');
                      }}
                    >
                      Download
                    </Button>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Loaded>
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
