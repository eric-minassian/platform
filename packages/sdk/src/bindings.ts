import { BINDINGS_ENV, type Bindings, decodeBindings } from '@ericminassian/platform-core';

let cached: Bindings | undefined;

/**
 * The stage's bindings, decoded lazily from `PLATFORM_BINDINGS` on first use
 * so importing the SDK never throws; using a resource without bindings does.
 */
export function getBindings(): Bindings {
  if (!cached) cached = decodeBindings(process.env[BINDINGS_ENV]);
  return cached;
}

/** Bindings if present, otherwise undefined (telemetry, health). */
export function tryBindings(): Bindings | undefined {
  try {
    return getBindings();
  } catch {
    return undefined;
  }
}

/** Override bindings (tests). Pass undefined to re-read the environment. */
export function setBindings(b: Bindings | undefined): void {
  cached = b;
}

export function region(): string {
  return tryBindings()?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
}

/** True under `plat dev` / `plat test` (AWS Emulator). */
export function isEmulator(): boolean {
  return Boolean(process.env.AWS_ENDPOINT_URL);
}
