import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import { api } from '../api.ts';
import { Button, cx, ErrorBox, Spinner } from './ui.tsx';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });
}

export function Layout() {
  const me = useMe();
  if (me.isPending) return <Spinner label="Signing in…" />;
  if (me.error) {
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorBox error={me.error} />
      </div>
    );
  }
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
            {me.data.role === 'admin' && (
              <NavLink to="/admin" className={link}>
                Admin
              </NavLink>
            )}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-muted">
            <a href={`https://github.com/${me.data.github}`} className="hover:text-fg">
              @{me.data.github}
            </a>
            <Button
              variant="ghost"
              onClick={async () => {
                await api.logout();
                location.assign('/login');
              }}
            >
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
