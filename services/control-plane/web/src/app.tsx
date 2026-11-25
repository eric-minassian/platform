import { RouterProvider } from '@tanstack/react-router';
import { Preferences } from '@ui-sdk/react/preferences';
import { StrictMode } from 'react';
import { Overlays } from './components/ui/overlays.tsx';
import { colorScheme } from './lib/color-scheme.ts';
import { PrefsProvider } from './lib/prefs.tsx';
import type { ConsoleRouter } from './router.tsx';

/** The console: the color scheme, per-viewer preferences, the pages, and toasts and confirmations. */
export function App({ router }: { router: ConsoleRouter }) {
  return (
    <StrictMode>
      <Preferences preferences={[colorScheme]}>
        <PrefsProvider>
          <RouterProvider router={router} />
          <Overlays />
        </PrefsProvider>
      </Preferences>
    </StrictMode>
  );
}
