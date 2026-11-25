import type { ReactElement } from 'react';
import { Mono } from '../components/page.tsx';
/**
 * Signed out: GitHub sign-in for people, and a pointer to the CLI for agents
 * (the full guide is in the HTML served before the console loads, and at
 * `/llms.txt`). The server sends a login it turned away back here with
 * `?denied=<login>`.
 */
import { BrandMark } from '../components/shell/sidebar.tsx';
import { Button } from '../components/ui/button.tsx';
import { loginRoute } from '../router.tsx';

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function LoginPage(): ReactElement {
  const search = loginRoute.useSearch();
  // The server keeps only a path on this site (`safeRedirect`).
  const redirect = search.redirect ?? '/';
  const denied = search.denied === undefined ? undefined : String(search.denied);
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <BrandMark />
          platform
        </div>
        <div className="flex flex-col gap-5 rounded-xl border bg-card p-6 shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="mt-1 text-sm text-muted-foreground">Members sign in with their GitHub account.</p>
          </div>
          {denied && (
            <p
              role="alert"
              className="rounded-lg border border-warn-mark/40 bg-warn-mark/8 px-3 py-2 text-sm text-warn"
            >
              @{denied} isn't a member. Members are listed in <Mono>platform.config.ts</Mono>.
            </p>
          )}
          <Button
            size="lg"
            render={
              <a
                href={`/auth/github/login?redirect=${encodeURIComponent(redirect)}`}
                aria-label="Sign in with GitHub"
              />
            }
          >
            <GitHubMark />
            Sign in with GitHub
          </Button>
        </div>
        <p className="px-1 text-sm text-pretty text-muted-foreground">
          Agents and scripts use the CLI instead: <Mono className="text-foreground">plat login</Mono> signs in
          with your GitHub CLI token. The guide is at{' '}
          <a href="/llms.txt" className="text-foreground underline-offset-4 hover:underline">
            /llms.txt
          </a>
          .
        </p>
      </div>
    </main>
  );
}
