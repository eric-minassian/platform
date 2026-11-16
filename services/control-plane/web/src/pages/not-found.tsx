import { Link } from '@tanstack/react-router';
import { EmptyState } from '../components/page.tsx';
import { Button } from '../components/ui/button.tsx';

export function NotFoundPage() {
  return (
    <div className="grid min-h-[60svh] place-items-center">
      <EmptyState
        title="There's no page here"
        action={
          <Button nativeButton={false} render={<Link to="/" />}>
            Go to apps
          </Button>
        }
      >
        The link may be old, or the app was removed.
      </EmptyState>
    </div>
  );
}
