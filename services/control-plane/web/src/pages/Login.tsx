import { useSearchParams } from 'react-router';

export function LoginPage() {
  const [params] = useSearchParams();
  const redirect = params.get('redirect') ?? '/';
  const denied = params.get('denied');
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-panel p-6">
        <div className="mb-5 flex items-center gap-2 text-lg font-semibold">
          <span className="size-5 rounded bg-accent" />
          platform
        </div>
        <p className="mb-5 text-[13px] text-muted">
          Deploy, observe and operate apps on <span className="text-fg">ericminassian.com</span>. Invite only.
        </p>
        {denied && (
          <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
            @{denied} isn't a member yet. Members are added in <code>platform.config.ts</code>.
          </div>
        )}
        <a
          href={`/auth/github/login?redirect=${encodeURIComponent(redirect)}`}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-fg px-3 py-2 text-[13px] font-medium text-bg hover:opacity-90"
        >
          <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          Sign in with GitHub
        </a>
      </div>
    </div>
  );
}
