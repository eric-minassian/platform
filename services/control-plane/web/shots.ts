/**
 * Screenshots of the console against the demo API (`src/demo`), so a UI
 * change can show its before and after without real data.
 *
 *   pnpm web:shots [--out <dir>] [--theme light|dark|both] [page…]
 *
 * Takes every page in PAGES (or the ones named) into `shots/` by default, in
 * the light theme; `both` writes `<page>-light.png` and `<page>-dark.png`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');

/** Each page worth a picture, on the demo's apps: atlas has jobs, inbox email, notes realtime. */
const PAGES: Record<string, string> = {
  apps: '/',
  overview: '/apps/atlas',
  metrics: '/apps/atlas/metrics',
  logs: '/apps/atlas/logs',
  traces: '/apps/atlas/traces',
  errors: '/apps/atlas/errors',
  alerts: '/apps/atlas/alerts?rule=a_jobs',
  jobs: '/apps/atlas/jobs',
  email: '/apps/inbox/email',
  realtime: '/apps/notes/realtime',
  database: '/apps/atlas/database',
  storage: '/apps/atlas/storage',
  deployments: '/apps/atlas/deployments',
  deployment: '/apps/atlas/deployments/dep_atlas_prod_4f2c1a90',
  secrets: '/apps/atlas/secrets',
  cost: '/apps/atlas/cost',
  settings: '/apps/atlas/settings',
  platform: '/platform',
  login: '/login',
};

const { values, positionals } = parseArgs({
  options: { out: { type: 'string', default: 'shots' }, theme: { type: 'string', default: 'light' } },
  allowPositionals: true,
});
const unknown = positionals.filter((p) => !(p in PAGES));
if (unknown.length) {
  console.error(`Unknown pages: ${unknown.join(', ')}. Pages: ${Object.keys(PAGES).join(', ')}`);
  process.exit(1);
}
const pages = positionals.length ? positionals : Object.keys(PAGES);
const themes =
  values.theme === 'both'
    ? (['light', 'dark'] as const)
    : ([values.theme === 'dark' ? 'dark' : 'light'] as const);

/** A port nothing listens on, so other worktrees' dev servers are left alone. */
const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address === 'object' ? done(address.port) : fail(new Error('no port')),
      );
    });
  });

async function waitFor(url: string, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`The demo API exited with ${child.exitCode}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`The demo API didn't answer at ${url}`);
}

/**
 * The page scrolls inside the content panel, so a full-page shot of the
 * window would stop at the fold: grow the viewport to the panel's content first.
 */
async function fullPanel(page: import('playwright').Page, path: string) {
  const extra = await page.evaluate(() => {
    const panel = document.getElementById('main-panel');
    return panel ? Math.max(0, panel.scrollHeight - panel.clientHeight) : 0;
  });
  await page.setViewportSize({ width: 1440, height: 900 + extra });
  await page.waitForTimeout(300);
  await page.screenshot({ path, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}

const apiPort = await freePort();
const demo = spawn(process.execPath, [join(root, 'src/demo/server.ts')], {
  env: { ...process.env, PORT: String(apiPort) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
// Read by web/vite.config.ts when the dev server starts.
process.env.PLATFORM_DEV_API = `http://127.0.0.1:${apiPort}`;
const vite = await createServer({
  configFile: join(root, 'web/vite.config.ts'),
  server: { host: '127.0.0.1', port: await freePort(), strictPort: true },
  logLevel: 'warn',
});
const browser = await chromium.launch();
try {
  await waitFor(`${process.env.PLATFORM_DEV_API}/v1/me`, demo);
  await vite.listen();
  const base = vite.resolvedUrls?.local[0]?.replace(/\/$/, '');
  if (!base) throw new Error("Vite didn't report its address");
  const out = resolve(values.out);
  await mkdir(out, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  for (const theme of themes) {
    // The console follows the system theme until someone picks one.
    await page.emulateMedia({ colorScheme: theme });
    for (const name of pages) {
      problems.length = 0;
      await page.goto(`${base}${PAGES[name]}`, { waitUntil: 'networkidle' });
      // Charts draw after their data arrives.
      await page.waitForTimeout(1500);
      const file = join(out, themes.length > 1 ? `${name}-${theme}.png` : `${name}.png`);
      await fullPanel(page, file);
      console.log(file);
      for (const p of problems) console.warn(`  ${name}: ${p.split('\n')[0]}`);
    }
  }
} finally {
  await browser.close();
  await vite.close();
  demo.kill();
}
