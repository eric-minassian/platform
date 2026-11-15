# template-app

A todo app on [the platform](https://github.com/eric-minassian/platform), with sign-in, a database, a
queue, an event, a cron and file storage. It lives at https://template-app.ericminassian.com.

```sh
pnpm install
pnpm dev        # http://template-app.localhost:3000 (AWS Emulator; install `aws-emulator` once)
pnpm test
pnpm test:e2e   # browser tests (Playwright); run `pnpm exec playwright install chromium` once
```

Pull requests deploy previews and `main` deploys production (`.github/workflows/platform.yml`). For
everything else (the SDK, recipes, debugging) see [AGENTS.md](./AGENTS.md).
