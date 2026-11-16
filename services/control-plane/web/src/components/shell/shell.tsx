/**
 * The signed-in console: sidebar, top bar and the page. Signs in first; the
 * API answers 401 for anyone else and the client sends them to the login page.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { MeResponse } from '@ericminassian/platform-core';
import { Outlet } from '@tanstack/react-router';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { logout } from '../../client.ts';
import { meAtom } from '../../data/atoms.ts';
import { ErrorNotice } from '../page.tsx';
import { SidebarInset, SidebarProvider } from '../ui/sidebar.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { AppSidebar, BrandMark } from './app-sidebar.tsx';
import { CommandMenu, useCommandMenu } from './command-menu.tsx';
import { TopBar } from './top-bar.tsx';

export function Shell() {
  return AsyncResult.match(useAtomValue(meAtom), {
    onInitial: () => (
      <div className="grid h-svh place-items-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <BrandMark />
          <Spinner />
        </div>
      </div>
    ),
    onFailure: ({ cause }) => (
      <div className="mx-auto max-w-md p-8">
        <ErrorNotice error={cause} />
      </div>
    ),
    onSuccess: ({ value: me }) => <Console me={me} />,
  });
}

function Console({ me }: { me: MeResponse }) {
  const signOut = useAtomSet(logout, { mode: 'promiseExit' });
  const [searchOpen, setSearchOpen] = useCommandMenu();
  return (
    <SidebarProvider>
      <AppSidebar
        me={me}
        onSignOut={() =>
          void (async () => {
            if (Exit.isSuccess(await signOut())) location.assign('/login');
          })()
        }
      />
      <SidebarInset className="min-w-0">
        <TopBar onSearch={() => setSearchOpen(true)} />
        <main className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-1 flex-col gap-4 px-4 py-5 md:px-6">
          <Outlet />
        </main>
      </SidebarInset>
      <CommandMenu open={searchOpen} onOpenChange={setSearchOpen} isAdmin={me.role === 'admin'} />
    </SidebarProvider>
  );
}
