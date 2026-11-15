/**
 * Publishes the public packages whose version isn't on npm yet, with npm
 * trusted publishing (GitHub Actions OIDC, no token) and provenance.
 *
 *   node scripts/release.ts               # publish (CI only: needs the OIDC env)
 *   node scripts/release.ts --check-trust # verify trusted publishing, publish nothing
 *   node scripts/release.ts --dry-run     # pack and `npm publish --dry-run`
 *
 * pnpm packs (it rewrites `workspace:` ranges and applies `publishConfig`);
 * the npm CLI publishes. pnpm requests its OIDC token with the audience
 * `npm:registry`, npm expects `npm:registry.npmjs.org`, and the registry
 * answers "OIDC permission denied for this action".
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Dependency order: each package's dependencies are published before it. */
const PACKAGES = ['packages/core', 'packages/sdk', 'packages/engine', 'packages/cli'];
const REGISTRY = 'https://registry.npmjs.org';
const root = new URL('..', import.meta.url).pathname;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const packages = PACKAGES.map((dir) => {
  const { name, version } = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  return { dir, name, version };
});

function onNpm(name: string, version: string): boolean {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry', REGISTRY], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === version;
  } catch {
    return false; // the package itself doesn't exist yet
  }
}

/** Exchanges this job's OIDC token for a publish token exactly as `npm publish` does, then discards it. */
async function checkTrust(name: string): Promise<void> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error('not running in GitHub Actions with `id-token: write`');
  const tokenUrl = new URL(url);
  tokenUrl.searchParams.set('audience', `npm:${new URL(REGISTRY).hostname}`);
  const idToken = (
    (await (await fetch(tokenUrl, { headers: { authorization: `bearer ${bearer}` } })).json()) as {
      value: string;
    }
  ).value;
  const escaped = name.replace('/', '%2f');
  const res = await fetch(`${REGISTRY}/-/npm/v1/oidc/token/exchange/package/${escaped}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(
      `trusted publishing is not set up for ${name} (${res.status} ${body.message ?? body.error ?? ''}). ` +
        `On npmjs.com → ${name} → Settings → Trusted publishing, add GitHub Actions with ` +
        `repository eric-minassian/platform and workflow release.yml (docs/SETUP.md step 10).`,
    );
  }
  console.log(`✓ trusted publishing works for ${name}`);
}

const pending = packages.filter((p) => {
  const published = onNpm(p.name, p.version);
  if (published) console.log(`· ${p.name}@${p.version} is already on npm`);
  return !published;
});

if (process.env.GITHUB_ACTIONS) for (const p of packages) await checkTrust(p.name);
if (args.has('--check-trust')) process.exit(0);

if (pending.length === 0) {
  console.log('Nothing to publish: bump a package version to release it.');
  process.exit(0);
}

const out = mkdtempSync(join(tmpdir(), 'release-'));
for (const p of pending) {
  const packed = execFileSync('pnpm', ['pack', '--pack-destination', out], {
    cwd: join(root, p.dir),
    encoding: 'utf8',
  });
  const tarball = packed.trim().split('\n').pop()!;
  execFileSync(
    'npm',
    [
      'publish',
      tarball,
      '--access',
      'public',
      '--registry',
      REGISTRY,
      ...(dryRun ? ['--dry-run'] : ['--provenance']),
    ],
    { stdio: 'inherit' },
  );
  console.log(`✓ ${dryRun ? 'would publish' : 'published'} ${p.name}@${p.version}`);
}
