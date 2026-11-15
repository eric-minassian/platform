# platform

A personal, AI-first PaaS on one AWS account. Apps are plain code plus a
cloud-neutral `plat.config.ts`; the platform provisions, deploys, routes and
observes them at `https://<app>.ericminassian.com`.

- [docs/DESIGN.md](docs/DESIGN.md): architecture, contracts and the decision log.
- [docs/SETUP.md](docs/SETUP.md): the one-time manual setup.
- [docs/MOVE-APP.md](docs/MOVE-APP.md): moving an app to its own AWS account (rare, manual).

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm test:integration   # needs the AWS Emulator (`aws-emulator` on PATH)
```
