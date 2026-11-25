import type { ErrorComponentProps } from '@tanstack/react-router';
import { RotateCw } from 'lucide-react';
import { EmptyState, ErrorNotice } from '../components/page.tsx';
import { Button } from '../components/ui/button.tsx';

/** What a page shows when it fails to load or throws, inside the console's frame. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="grid min-h-[50dvh] place-items-center">
      <EmptyState
        title="This page didn't load"
        action={
          <Button
            variant="outline"
            onClick={() => {
              // A failed lazy import (often a deploy that replaced the files) needs a fresh page.
              if (error instanceof TypeError && /dynamically imported module/.test(error.message))
                location.reload();
              else reset();
            }}
          >
            <RotateCw />
            Try again
          </Button>
        }
      >
        <ErrorNotice error={error} className="mt-2 text-left" />
      </EmptyState>
    </div>
  );
}
