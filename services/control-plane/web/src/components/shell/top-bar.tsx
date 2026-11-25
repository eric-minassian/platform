/** Where you are, and the time window for pages that show data over time. */
import { Link, useMatches } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { Fragment } from 'react';
import { useAppName, useStage } from '../../lib/hooks.ts';
import { Button } from '../ui/button.tsx';
import { TimePicker } from './time-picker.tsx';

export function TopBar({ onMenu }: { onMenu: () => void }) {
  const matches = useMatches();
  const app = useAppName();
  const stage = useStage();
  const title = matches.findLast((m) => m.staticData.title)?.staticData.title;
  const showsTime = matches.some((m) => m.staticData.time);
  const crumbs: Array<{ key: string; label: string; to?: 'app' }> = [
    ...(app ? [{ key: 'app', label: app, to: 'app' as const }] : []),
    ...(app && stage !== 'prod' ? [{ key: 'stage', label: stage }] : []),
    ...(title ? [{ key: 'page', label: title }] : []),
  ];
  return (
    <header className="sticky top-0 z-20 flex h-13 shrink-0 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur-md md:px-5">
      <Button variant="ghost" size="icon-sm" aria-label="Open menu" className="md:hidden" onClick={onMenu}>
        <Menu />
      </Button>
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-2 text-sm">
          {crumbs.map((c, i) => (
            <Fragment key={c.key}>
              {i > 0 && (
                <li aria-hidden className="text-border-strong">
                  /
                </li>
              )}
              <li className="min-w-0 truncate">
                {c.to === 'app' && app ? (
                  <Link
                    to="/apps/$app"
                    params={{ app }}
                    className="rounded-sm text-muted-foreground outline-hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-solid"
                  >
                    {c.label}
                  </Link>
                ) : i === crumbs.length - 1 ? (
                  <span aria-current="page" className="font-medium">
                    {c.label}
                  </span>
                ) : (
                  <span className="font-mono text-[13px] text-muted-foreground">{c.label}</span>
                )}
              </li>
            </Fragment>
          ))}
        </ol>
      </nav>
      <div className="ml-auto flex items-center gap-2">{showsTime && <TimePicker />}</div>
    </header>
  );
}
