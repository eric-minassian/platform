/**
 * The signed-in console: the sidebar on the canvas, and the page in a panel
 * beside it. Signs in first; the API answers 401 for anyone else and the
 * client sends them to the login page.
 */
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import type { MeResponse } from '@ericminassian/platform-core';
import { Outlet, useMatches, useRouterState } from '@tanstack/react-router';
import { createDialogController } from '@ui-sdk/react/dialog';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { Exit } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useState } from 'react';
import { logout } from '../../client.ts';
import { meAtom } from '../../data/atoms.ts';
import { usePrefs } from '../../lib/prefs.tsx';
import { cn } from '../../lib/utils.ts';
import { ErrorNotice } from '../page.tsx';
import { Drawer, DrawerContent, DrawerTitle } from '../ui/drawer.tsx';
import { Spinner } from '../ui/spinner.tsx';
import { CommandMenu } from './command-menu.tsx';
import { BrandMark, Sidebar } from './sidebar.tsx';
import { TopBar } from './top-bar.tsx';

export function Shell() {
  return AsyncResult.match(useAtomValue(meAtom), {
    onInitial: () => (
      <div className="grid h-dvh place-items-center">
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
  const signOutAtom = useAtomSet(logout, { mode: 'promiseExit' });
  const { sidebarFolded: folded, set } = usePrefs();
  const [search] = useState(() => createDialogController<unknown, unknown>());
  // The phone menu is open on the page it was opened on: navigating closes it.
  const path = useRouterState({ select: (s) => s.location.pathname });
  const fill = useMatches({ select: (matches) => matches.some((m) => m.staticData.fill) });
  const [menuOpenOn, setMenuOpenOn] = useState<string | null>(null);
  const mobileNav = menuOpenOn === path;
  const setMobileNav = (open: boolean) => setMenuOpenOn(open ? path : null);

  const toggleFold = () => set({ sidebarFolded: !folded });
  useShortcut('mod+b', toggleFold, { description: 'Fold or unfold the sidebar' });
  useShortcut('mod+k', () => search.toggle(), { description: 'Search', allowInInput: true });

  const signOut = () =>
    void (async () => {
      if (Exit.isSuccess(await signOutAtom())) location.assign('/login');
    })();
  const openSearch = () => {
    setMobileNav(false);
    void search.open();
  };

  return (
    <div className="flex h-dvh min-h-0 bg-canvas">
      <aside
        aria-label="Sidebar"
        className={cn('hidden shrink-0 transition-[width] duration-200 md:block', folded ? 'w-14' : 'w-60')}
      >
        <Sidebar me={me} folded={folded} onFold={toggleFold} onSearch={openSearch} onSignOut={signOut} />
      </aside>
      <Drawer side="left" open={mobileNav} onOpenChange={setMobileNav}>
        <DrawerContent width="17rem" className="border-r border-l-0 bg-canvas" closeLabel="Close menu">
          <DrawerTitle className="sr-only">Menu</DrawerTitle>
          <Sidebar me={me} folded={false} onSearch={openSearch} onSignOut={signOut} />
        </DrawerContent>
      </Drawer>
      <div
        id="main-panel"
        data-scroll-restoration-id="main-panel"
        className="relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-background md:my-2 md:mr-2 md:rounded-xl md:border"
      >
        <TopBar onMenu={() => setMobileNav(true)} />
        <main
          className={cn(
            'mx-auto flex w-full max-w-[1400px] min-w-0 flex-1 flex-col gap-5 px-4 pt-6 md:px-8',
            fill ? 'pb-5' : 'pb-16',
          )}
        >
          <Outlet />
        </main>
      </div>
      <CommandMenu controller={search} isAdmin={me.role === 'admin'} />
    </div>
  );
}
