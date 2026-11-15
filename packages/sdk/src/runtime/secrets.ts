import type { SecretName } from '../register.ts';
import { getBindings } from './bindings.ts';
import { client } from './clients.ts';
import { span } from './telemetry.ts';

export interface Secrets {
  /** Throws if missing. Stage value wins over the app-wide shared value. Cached ~5 min. */
  get(name: SecretName): Promise<string>;
  getOptional(name: SecretName): Promise<string | undefined>;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string | undefined; at: number }>();

async function read(path: string): Promise<string | undefined> {
  try {
    const { GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const out = await (await client('ssm')).send(
      new GetParameterCommand({ Name: path, WithDecryption: true }),
    );
    return out.Parameter?.Value;
  } catch (e) {
    if ((e as { name?: string })?.name === 'ParameterNotFound') return undefined;
    throw e;
  }
}

async function lookup(name: string): Promise<string | undefined> {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const { secrets } = getBindings();
  const value = await span(
    'secrets.get',
    name,
    async () => (await read(`${secrets.path}${name}`)) ?? read(`${secrets.sharedPath}${name}`),
  );
  cache.set(name, { value, at: Date.now() });
  return value;
}

export const secrets: Secrets = {
  async get(name) {
    const v = await lookup(name);
    if (v === undefined) {
      const b = getBindings();
      throw new Error(
        `Secret ${name} is not set. Run: plat secrets set ${b.app} ${name} --stage ${b.stage}  (or without --stage for all stages)`,
      );
    }
    return v;
  },
  getOptional: (name) => lookup(name),
};

/** Drop cached values (tests). */
export function clearSecretsCache(): void {
  cache.clear();
}
