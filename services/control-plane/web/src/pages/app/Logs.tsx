import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { LogLine } from '@ericminassian/platform-core';
import { TailEvent } from '@ericminassian/platform-core/platform-api';
import { Schema } from 'effect';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiClient, apiUrl, loadedPages, pages } from '../../client.ts';
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
import { type Scope, useApp } from '../AppLayout.tsx';

const levelTone = (l?: string): Tone =>
  l === 'error' ? 'bad' : l === 'warn' ? 'warn' : l === 'debug' || l === 'system' ? 'muted' : 'info';

export function LogRows({ lines, app, search }: { lines: readonly LogLine[]; app: string; search: string }) {
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

interface LogsQuery extends Scope {
  app: string;
  q: string;
  stream: string;
}

const logPages = Atom.family(({ app, stage, range, q, stream }: LogsQuery) =>
  pages(
    (next) =>
      ApiClient.use((client) =>
        client.observe.logs({
          params: { app },
          query: {
            stage,
            range,
            q: q || undefined,
            stream: stream === 'web' || stream === 'worker' ? stream : undefined,
            next,
          },
        }),
      ),
    (page) => page.nextToken,
  ),
);

// The tail's server-sent events are `{ event, data }` pairs, as `PlatformApi` describes them.
const decodeTailEvent = Schema.decodeUnknownOption(TailEvent);

function useLiveTail(url: string) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLines([]);
    setError(null);
    const es = new EventSource(url, { withCredentials: true });
    // A dropped connection fires a plain `error` event without data, which doesn't decode.
    const onEvent = (e: Event) => {
      const decoded = decodeTailEvent({ event: e.type, data: (e as MessageEvent<unknown>).data });
      if (decoded._tag === 'None') return;
      const event = decoded.value;
      if (event.event === 'line') setLines((prev) => [event.data, ...prev].slice(0, 1000));
      else setError(event.data);
    };
    es.addEventListener('line', onEvent);
    es.addEventListener('error', onEvent);
    return () => es.close();
  }, [url]);
  return { lines, error };
}

function Lines({
  all,
  live,
  showSystem,
  app,
  search,
}: {
  all: readonly LogLine[];
  live: boolean;
  showSystem: boolean;
  app: string;
  search: string;
}) {
  const lines = showSystem ? all : all.filter((l) => l.level !== 'system');
  return (
    <div className="max-h-[65vh] overflow-y-auto">
      {lines.length === 0 ? (
        <div className="py-8 text-center text-[12px] text-muted">
          {live ? 'Waiting for log lines…' : 'No log lines in this range.'}
        </div>
      ) : (
        <LogRows lines={lines} app={app} search={search} />
      )}
    </div>
  );
}

function Tail({ query, showSystem, search }: { query: LogsQuery; showSystem: boolean; search: string }) {
  const url = apiUrl.observe.tail({
    params: { app: query.app },
    query: { stage: query.stage, q: query.q || undefined },
  });
  const tail = useLiveTail(url);
  return (
    <>
      {tail.error && <ErrorBox error={tail.error} />}
      <Lines all={tail.lines} live showSystem={showSystem} app={query.app} search={search} />
    </>
  );
}

function History({ query, showSystem, search }: { query: LogsQuery; showSystem: boolean; search: string }) {
  const atom = logPages(query);
  const result = useAtomValue(atom);
  const loadMore = useAtomSet(atom);
  const loaded = loadedPages(result);
  return (
    <>
      {result._tag === 'Failure' && <ErrorBox error={result.cause} />}
      {AsyncResult.isInitial(result) ? (
        <Spinner />
      ) : (
        <Lines
          all={loaded.flatMap((p) => p.lines)}
          live={false}
          showSystem={showSystem}
          app={query.app}
          search={search}
        />
      )}
      {loaded.at(-1)?.nextToken !== undefined && (
        <div className="pt-2">
          <Button onClick={() => loadMore()} disabled={result.waiting}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function LogsTab() {
  const { app, scope, search } = useApp();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [stream, setStream] = useState('');
  // The Lambda runtime's own records (one summary per minute) drown out app logs.
  const [showSystem, setShowSystem] = useState(false);
  const [live, setLive] = useState(false);
  const query: LogsQuery = { app, ...scope, q, stream };

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
      {live ? (
        <Tail query={query} showSystem={showSystem} search={search} />
      ) : (
        <History query={query} showSystem={showSystem} search={search} />
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
