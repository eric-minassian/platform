/** Hooks for the URL state every page shares: the time window, the stage, the app. */
import { useAtomRefresh } from '@effect/atom-react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { AsyncResult, type Atom } from 'effect/reactivity';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrefs } from './prefs.tsx';
import {
  apiTime,
  resolveWindow,
  type TimeSearch,
  type TimeWindow,
  validateTimeSearch,
  zoomTo,
} from './time.ts';

/** Re-renders every `ms` while the tab is visible, for windows that move with now. */
export function useNow(ms: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export interface PageTime {
  readonly search: TimeSearch;
  readonly window: TimeWindow;
  /** The API's time params: `range` for a relative window (the server applies its clock), else `from`/`to`. */
  readonly api: ReturnType<typeof apiTime>;
  readonly set: (next: TimeSearch) => void;
  readonly zoom: (from: number, to: number) => void;
}

export function useTime(): PageTime {
  const raw: Record<string, unknown> = useSearch({ strict: false });
  const search = useMemo(() => validateTimeSearch(raw), [raw]);
  const { refreshMs } = usePrefs();
  const now = useNow(search.from === undefined ? refreshMs || 60_000 : undefined);
  const navigate = useNavigate();
  const set = useCallback(
    (next: TimeSearch) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          range: next.range,
          from: next.from,
          to: next.to,
        }),
      } as never);
    },
    [navigate],
  );
  const zoom = useCallback((from: number, to: number) => set(zoomTo(from, to)), [set]);
  return useMemo(
    () => ({ search, window: resolveWindow(search, now), api: apiTime(search), set, zoom }),
    [search, now, set, zoom],
  );
}

/** The stage the app pages show (`?stage=`, prod by default). */
export function useStage(): string {
  const search: { stage?: unknown } = useSearch({ strict: false });
  return typeof search.stage === 'string' && search.stage ? search.stage : 'prod';
}

/** The app in the URL, when the page is one of an app's. */
export function useAppName(): string | undefined {
  const params: { app?: string } = useParams({ strict: false });
  return params.app;
}

/**
 * Refreshes a query on the viewer's auto-refresh interval while the window
 * is relative (an absolute window never changes), and the tab is visible.
 */
export function useAutoRefresh(atom: Atom.Atom<unknown>, relative: boolean): void {
  const refresh = useAtomRefresh(atom);
  const { refreshMs, refreshNonce } = usePrefs();
  // The refresh button bumps the nonce; the nonce the query mounted with needs no refetch.
  const seen = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === seen.current) return;
    seen.current = refreshNonce;
    refresh();
  }, [refreshNonce, refresh]);
  useEffect(() => {
    if (!relative || !refreshMs) return undefined;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, refreshMs);
    return () => clearInterval(id);
  }, [refresh, refreshMs, relative]);
}

/**
 * A query's result that keeps showing the last value while a new key loads
 * (a window that moved), instead of flashing back to loading.
 */
export function useSticky<A, E>(result: AsyncResult.AsyncResult<A, E>): AsyncResult.AsyncResult<A, E> {
  const [last, setLast] = useState(result);
  // Remembering the latest success is derived state, updated while rendering.
  if (AsyncResult.isSuccess(result) && result !== last) setLast(result);
  if (AsyncResult.isInitial(result) && AsyncResult.isSuccess(last)) return AsyncResult.waiting(last);
  return result;
}
