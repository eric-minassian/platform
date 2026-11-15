import type { LogLine } from '@ericminassian/platform-core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../api.ts';
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorBox,
  Input,
  Mono,
  Select,
  Spinner,
  type Tone,
} from '../../components/ui.tsx';
import { fmtDateTime } from '../../format.ts';
import { useApp } from '../AppLayout.tsx';

const levelTone = (l?: string): Tone =>
  l === 'error' ? 'bad' : l === 'warn' ? 'warn' : l === 'debug' || l === 'system' ? 'muted' : 'info';

export function LogRows({ lines, app, search }: { lines: LogLine[]; app: string; search: string }) {
  return (
    <div className="divide-y divide-border/60 font-mono text-[11.5px]">
      {lines.map((l, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines have no stable id
          key={i}
          className="flex gap-3 px-1 py-1 hover:bg-panel-2"
        >
          <span className="shrink-0 text-muted">{fmtDateTime(l.ts)}</span>
          <span className={cx('w-12 shrink-0', l.stream === 'worker' ? 'text-warn' : 'text-info')}>
            {l.stream}
          </span>
          <span className="w-12 shrink-0">
            {l.level && <Badge tone={levelTone(l.level)}>{l.level}</Badge>}
          </span>
          <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{l.message}</span>
          {l.trace && (
            <Link
              to={`/apps/${app}/traces/${l.trace}${search}`}
              className="shrink-0 text-accent hover:underline"
            >
              trace
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

function useLiveTail(url: string | null) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    setLines([]);
    setError(null);
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('line', (e) => {
      const line = JSON.parse((e as MessageEvent<string>).data) as LogLine;
      setLines((prev) => [line, ...prev].slice(0, 1000));
    });
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent<string>).data;
      if (data) setError(data);
    });
    return () => es.close();
  }, [url]);
  return { lines, error };
}

export function LogsTab() {
  const { app, scope, search } = useApp();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [stream, setStream] = useState('');
  // The Lambda runtime's own records (one summary per minute) drown out app logs.
  const [showSystem, setShowSystem] = useState(false);
  const [live, setLive] = useState(false);
  const tail = useLiveTail(live ? api.tailUrl(app, scope.stage, q || undefined) : null);
  const history = useInfiniteQuery({
    queryKey: ['logs', app, scope, q, stream],
    queryFn: ({ pageParam }) =>
      api.logs(app, { ...scope, q, stream, ...(pageParam ? { next: pageParam } : {}) }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextToken,
    enabled: !live,
  });
  const all = live ? tail.lines : (history.data?.pages.flatMap((p) => p.lines) ?? []);
  const lines = showSystem ? all : all.filter((l) => l.level !== 'system');
  const scroller = useRef<HTMLDivElement>(null);

  return (
    <Card
      title={live ? 'Live tail' : 'Logs'}
      actions={
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQ(draft.trim());
            }}
            className="flex items-center gap-2"
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="text or { $.status = 500 }"
              className="w-64"
            />
          </form>
          <Select
            value={stream}
            onChange={setStream}
            options={[
              { value: '', label: 'all streams' },
              { value: 'web', label: 'web' },
              { value: 'worker', label: 'worker' },
            ]}
          />
          <Select
            value={showSystem ? 'all' : 'app'}
            onChange={(v) => setShowSystem(v === 'all')}
            options={[
              { value: 'app', label: 'app lines' },
              { value: 'all', label: 'app + runtime' },
            ]}
          />
          <Button variant={live ? 'primary' : 'default'} onClick={() => setLive((v) => !v)}>
            {live ? '● Live' : 'Go live'}
          </Button>
        </>
      }
    >
      {live && tail.error && <ErrorBox error={tail.error} />}
      {!live && history.error && <ErrorBox error={history.error} />}
      {!live && history.isPending ? (
        <Spinner />
      ) : (
        <div ref={scroller} className="max-h-[65vh] overflow-y-auto">
          {lines.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted">
              {live ? 'Waiting for log lines…' : 'No log lines in this range.'}
            </div>
          ) : (
            <LogRows lines={lines} app={app} search={search} />
          )}
        </div>
      )}
      {!live && history.hasNextPage && (
        <div className="pt-2">
          <Button onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
      <p className="pt-2 text-[11px] text-muted">
        Same as{' '}
        <Mono>
          plat logs {app} --stage {scope.stage}
        </Mono>
      </p>
    </Card>
  );
}
