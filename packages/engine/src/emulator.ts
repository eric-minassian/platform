import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Thin wrapper around the AWS Emulator (https://docs.aws.amazon.com/emulator/):
 * one local HTTPS endpoint for many AWS APIs, state in memory. Used by
 * `plat dev`, `plat test` and the engine's own integration tests.
 *
 * Install once per machine (Linux): see docs/SETUP.md, or the AWS docs. On
 * macOS/Windows run it in Docker and point `PLAT_EMULATOR_ENDPOINT` at it.
 */
export interface EmulatorConnection {
  endpoint: string;
  /** PEM bundle for the emulator's self-signed TLS certificate. */
  caFile: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
  /** Fixed by the emulator. */
  accountId: '000000000000';
  /**
   * Environment for child processes (web server, tests) so the AWS SDK and CLI
   * talk to the emulator: endpoint, CA bundle, credentials, region.
   */
  env: Record<string, string>;
  /** Variables to delete from a child environment (a developer's real AWS profile/session). */
  unsetEnv: readonly string[];
  /** Stops the emulator (state is discarded). No-op for an external emulator. */
  stop(): Promise<void>;
}

export interface StartEmulatorOptions {
  /** Path to the `aws-emulator` binary. Default: `$PLAT_EMULATOR_BIN`, then `PATH`. */
  bin?: string;
  /** 0 picks a free port. */
  port?: number;
  region?: string;
  /** Exit after this many idle seconds (safety net for crashed parents). */
  idleTimeoutSeconds?: number;
  /** Isolated HOME for the emulator's generated credentials. Default: a temp dir. */
  home?: string;
  /** Forward emulator log lines. */
  onLog?: (line: string) => void;
  startupTimeoutMs?: number;
}

export const EMULATOR_INSTALL_HINT = `AWS Emulator not found. Install it once (Debian/Ubuntu):
  curl -fsSLo aws-emulator.deb https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb
  sudo apt-get install -y ./aws-emulator.deb
RPM, arm64 and Docker (macOS/Windows) instructions: https://docs.aws.amazon.com/emulator/latest/userguide/getting-started.html
Or set PLAT_EMULATOR_BIN to the binary, or PLAT_EMULATOR_ENDPOINT (+ PLAT_EMULATOR_HOME) to a running emulator.`;

export function findEmulatorBinary(explicit?: string): string | null {
  const candidates = [explicit, process.env.PLAT_EMULATOR_BIN].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, 'aws-emulator');
    if (dir && existsSync(p)) return p;
  }
  const opt = '/opt/aws-emulator/bin/aws-emulator';
  return existsSync(opt) ? opt : null;
}

export function emulatorVersion(bin: string): string | null {
  const r = spawnSync(bin, ['-v'], { encoding: 'utf8' });
  const m = /Version:\s*(\S+)/.exec(r.stdout ?? '');
  return m?.[1] ?? null;
}

export async function startEmulator(opts: StartEmulatorOptions = {}): Promise<EmulatorConnection> {
  const region = opts.region ?? 'us-east-1';
  const external = process.env.PLAT_EMULATOR_ENDPOINT;
  if (external) return connectExternal(external, region, process.env.PLAT_EMULATOR_HOME ?? homedir());

  const bin = findEmulatorBinary(opts.bin);
  if (!bin) throw new Error(EMULATOR_INSTALL_HINT);
  const home = opts.home ?? join(tmpdir(), `plat-emulator-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const args = ['-p', String(opts.port ?? 0), '-t', 'off'];
  if (opts.idleTimeoutSeconds) args.push('--idle-timeout', String(opts.idleTimeoutSeconds));
  const child = spawn(bin, args, {
    env: { ...process.env, HOME: home, EMULATOR_TELEMETRY: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const info = await new Promise<{ endpoint: string; caFile: string; credentialsFile: string }>(
    (resolve, reject) => {
      let credentialsFile = '';
      const timer = setTimeout(
        () => reject(new Error('AWS Emulator did not start within the timeout')),
        opts.startupTimeoutMs ?? 20_000,
      );
      const onLine = (line: string) => {
        opts.onLog?.(line);
        let parsed: { fields?: Record<string, string> } | undefined;
        try {
          parsed = JSON.parse(line) as { fields?: Record<string, string> };
        } catch {
          return;
        }
        const f = parsed?.fields ?? {};
        if (f.credentials_file) credentialsFile = f.credentials_file;
        if (f.message === 'emulator server information' && f.endpoint_url && f.ca_file) {
          clearTimeout(timer);
          resolve({ endpoint: f.endpoint_url, caFile: f.ca_file, credentialsFile });
        }
      };
      createInterface({ input: child.stdout }).on('line', onLine);
      createInterface({ input: child.stderr }).on('line', onLine);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`AWS Emulator exited during startup (code ${code})`));
      });
    },
  );

  return {
    ...buildConnection(info.endpoint, info.caFile, readCredentials(info.credentialsFile), region),
    stop: () => stopChild(child),
  };
}

function connectExternal(endpoint: string, region: string, home: string): EmulatorConnection {
  const port = new URL(endpoint).port || '9297';
  const dir = join(home, '.aws', 'emulator', port);
  return {
    ...buildConnection(
      endpoint,
      join(dir, 'ca.pem'),
      readCredentials(join(dir, 'emulator_credentials')),
      region,
    ),
    stop: async () => {},
  };
}

function buildConnection(
  endpoint: string,
  caFile: string,
  credentials: EmulatorConnection['credentials'],
  region: string,
): Omit<EmulatorConnection, 'stop'> {
  return {
    endpoint,
    caFile,
    credentials,
    region,
    accountId: '000000000000',
    env: {
      AWS_ENDPOINT_URL: endpoint,
      AWS_CA_BUNDLE: caFile,
      NODE_EXTRA_CA_CERTS: caFile,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
      AWS_EC2_METADATA_DISABLED: 'true',
      AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
    },
    unsetEnv: EMULATOR_UNSET_ENV,
  };
}

/** A developer's real AWS identity must never leak into emulator runs. */
export const EMULATOR_UNSET_ENV = [
  'AWS_PROFILE',
  'AWS_SESSION_TOKEN',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
] as const;

/** `process.env` + emulator connection env, minus a developer's real AWS identity. */
export function emulatorChildEnv(
  conn: Pick<EmulatorConnection, 'env' | 'unsetEnv'>,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...base, ...conn.env };
  for (const k of conn.unsetEnv) delete env[k];
  return env;
}

function readCredentials(file: string): EmulatorConnection['credentials'] {
  const text = readFileSync(file, 'utf8');
  const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*(\\S+)`, 'm').exec(text)?.[1];
  const accessKeyId = get('aws_access_key_id');
  const secretAccessKey = get('aws_secret_access_key');
  if (!accessKeyId || !secretAccessKey) throw new Error(`Could not read emulator credentials from ${file}`);
  return { accessKeyId, secretAccessKey };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
