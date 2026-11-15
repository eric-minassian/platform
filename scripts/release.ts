/**
 * Publishes the public packages whose version isn't on npm yet, with npm
 * trusted publishing (GitHub Actions OIDC, no token) and provenance.
 *
 *   node scripts/release.ts               # publish (CI only: needs the OIDC env)
 *   node scripts/release.ts --check-trust # verify trusted publishing, publish nothing
 *   node scripts/release.ts --dry-run     # pack and `npm publish --dry-run`
 *
 * pnpm packs (it rewrites `workspace:` ranges and applies `publishConfig`);
 * the npm CLI publishes, since npm documents trusted publishing for its own CLI.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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

/** The one-time fix for a package whose trusted publisher is missing or can't `npm publish`. */
function trustFix(name: string): string {
  return (
    `Recreate its trusted publisher with \`npm publish\` allowed: \`npm trust list ${name}\`, ` +
    `\`npm trust revoke ${name} --id <id>\`, then \`npm trust github ${name} --file release.yml ` +
    `--repo eric-minassian/platform --allow-publish\` (docs/SETUP.md step 10).`
  );
}

/**
 * Exchanges this job's OIDC token for a publish token exactly as `npm publish`
 * does, then discards it. This proves the trusted publisher matches this
 * workflow, not that it may `npm publish`: the exchange also succeeds for a
 * publisher that only allows `npm stage publish`.
 */
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
      `npm has no trusted publisher for ${name} that matches this workflow ` +
        `(${res.status} ${body.message ?? body.error ?? ''}). ${trustFix(name)}`,
    );
  }
  console.log(`✓ npm accepts this workflow's OIDC token for ${name}`);
}

function publish(tarball: string, name: string): void {
  const res = spawnSync(
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
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'] },
  );
  if (res.error) throw res.error;
  process.stderr.write(res.stderr);
  if (res.status === 0) return;
  // The registry's answer when the publisher matched but isn't allowed to `npm publish`:
  // publishers created since 2026-09-03 allow only `npm stage publish` unless told otherwise.
  if (res.stderr.includes('OIDC permission denied')) {
    throw new Error(`npm refused to publish ${name} with this workflow's OIDC token. ${trustFix(name)}`);
  }
  throw new Error(`npm publish failed for ${name} (exit ${res.status ?? res.signal})`);
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
  publish(tarball, p.name);
  console.log(`✓ ${dryRun ? 'would publish' : 'published'} ${p.name}@${p.version}`);
}
