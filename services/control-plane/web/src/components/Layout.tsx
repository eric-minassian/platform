import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { MeResponse } from '@ericminassian/platform-core';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { NavLink, Outlet } from 'react-router';
import { ApiClient, fresh, logout, timeToLive } from '../client.ts';
import { Button, cx, ErrorBox, Spinner } from './ui.tsx';

const meAtom = fresh(ApiClient.query('session', 'me', { timeToLive }), { staleTime: '5 minutes' });

export function Layout() {
  return AsyncResult.match(useAtomValue(meAtom), {
    onInitial: () => <Spinner label="Signing in…" />,
    onFailure: ({ cause }) => (
      <div className="mx-auto max-w-md p-8">
        <ErrorBox error={cause} />
      </div>
    ),
    onSuccess: ({ value: me }) => <Shell me={me} />,
  });
}

function Shell({ me }: { me: MeResponse }) {
  const logoutExit = useAtomSet(logout, { mode: 'promiseExit' });
  const signOut = async () => {
    if (Exit.isSuccess(await logoutExit())) location.assign('/login');
  };
  const link = ({ isActive }: { isActive: boolean }) =>
    cx('rounded-md px-2 py-1 text-[12px]', isActive ? 'bg-panel-2 text-fg' : 'text-muted hover:text-fg');
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-panel/90 backdrop-blur">
        <div className="mx-auto flex h-11 max-w-7xl items-center gap-4 px-4">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <span className="size-4 rounded bg-accent" />
            platform
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={link}>
              Apps
            </NavLink>
            {me.role === 'admin' && (
              <NavLink to="/admin" className={link}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-muted">
            <a href={`https://github.com/${me.github}`} className="hover:text-fg">
              @{me.github}
            </a>
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-5">
        <Outlet />
      </main>
    </div>
  );
}
