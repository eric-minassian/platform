/** Where you are, the command menu, and the time window for pages that show data over time. */
import { Link, useMatches } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Fragment } from 'react';
import { useAppName, useStage } from '../../lib/hooks.ts';
import { Kbd } from '../ui/kbd.tsx';
import { Separator } from '../ui/separator.tsx';
import { SidebarTrigger } from '../ui/sidebar.tsx';
import { TimePicker } from './time-picker.tsx';

export function TopBar({ onSearch }: { onSearch: () => void }) {
  const matches = useMatches();
  const app = useAppName();
  const stage = useStage();
  const title = matches.findLast((m) => m.staticData.title)?.staticData.title;
  const showsTime = matches.some((m) => m.staticData.time);
  const crumbs: Array<{ key: string; label: string; to?: 'app' }> = [
    ...(app ? [{ key: 'app', label: app, to: 'app' as const }] : []),
    ...(app && stage !== 'prod' ? [{ key: 'stage', label: stage }] : []),
    ...(title && !(app && title === 'Overview') ? [{ key: 'page', label: title }] : []),
  ];
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <SidebarTrigger className="text-muted-foreground" />
      <Separator orientation="vertical" className="mr-1 h-4 self-center" />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <Fragment key={c.key}>
            {i > 0 && <span className="text-subtle">/</span>}
            {c.to === 'app' && app ? (
              <Link
                to="/apps/$app"
                params={{ app }}
                className="truncate font-medium text-muted-foreground hover:text-foreground"
              >
                {c.label}
              </Link>
            ) : (
              <span
                className={
                  i === crumbs.length - 1 ? 'truncate font-medium' : 'truncate text-muted-foreground'
                }
              >
                {c.label}
              </span>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-7 w-64 items-center gap-2 rounded-md border bg-card px-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring lg:flex"
        >
          <Search className="size-3.5" />
          <span className="flex-1 truncate">Jump to app, page or trace</span>
          <Kbd>⌘K</Kbd>
        </button>
        {showsTime && <TimePicker />}
      </div>
    </header>
  );
}
