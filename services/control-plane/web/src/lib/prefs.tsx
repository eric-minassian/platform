/**
 * Per-viewer display preferences, kept in this browser only: whether times
 * show in UTC, how often live pages refresh and whether the sidebar is
 * folded to icons. The color scheme is its own preference (`color-scheme.ts`).
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

export const REFRESH_INTERVALS = [
  { value: 0, label: 'Off' },
  { value: 10_000, label: '10s' },
  { value: 30_000, label: '30s' },
  { value: 60_000, label: '1m' },
  { value: 300_000, label: '5m' },
] as const;

interface Prefs {
  readonly utc: boolean;
  /** Milliseconds between refreshes of a relative range; 0 is off. */
  readonly refreshMs: number;
  /** The sidebar shows icons only, giving wide pages room. */
  readonly sidebarFolded: boolean;
}

const DEFAULTS: Prefs = { utc: false, refreshMs: 30_000, sidebarFolded: false };
const KEY = 'platform-console:prefs';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS;
    const p = parsed as Partial<Record<keyof Prefs, unknown>>;
    return {
      utc: typeof p.utc === 'boolean' ? p.utc : DEFAULTS.utc,
      refreshMs: REFRESH_INTERVALS.some((r) => r.value === p.refreshMs)
        ? (p.refreshMs as number)
        : DEFAULTS.refreshMs,
      sidebarFolded: typeof p.sidebarFolded === 'boolean' ? p.sidebarFolded : DEFAULTS.sidebarFolded,
    };
  } catch {
    return DEFAULTS;
  }
}

interface PrefsContext extends Prefs {
  readonly set: (patch: Partial<Prefs>) => void;
  /** Bumped by the top bar's refresh button: every live query refetches. */
  readonly refreshNonce: number;
  readonly refreshNow: () => void;
}

const Context = createContext<PrefsContext>({
  ...DEFAULTS,
  set: () => undefined,
  refreshNonce: 0,
  refreshNow: () => undefined,
});

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(load);
  const set = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage can be unavailable (private windows); the choice still holds for this tab.
      }
      return next;
    });
  }, []);
  const [refreshNonce, setNonce] = useState(0);
  const refreshNow = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo(
    () => ({ ...prefs, set, refreshNonce, refreshNow }),
    [prefs, set, refreshNonce, refreshNow],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const usePrefs = (): PrefsContext => useContext(Context);
