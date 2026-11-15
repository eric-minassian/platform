/** Isomorphic (Node ≥ 19 and browsers): uses Web Crypto. */
function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase

/**
 * Time-sortable id (ULID layout, lowercase): 10 chars of ms timestamp + 16
 * random chars. Safe in S3 keys, DNS-free contexts and DynamoDB sort keys.
 */
export function newId(prefix = ''): string {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 32]! + time;
    ts = Math.floor(ts / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return prefix + time + rand;
}

/** Deployment ids start with `d` so they're recognizable in keys and logs. */
export function newDeploymentId(): string {
  return newId('d');
}

export function newTraceId(): string {
  return hex(randomBytes(16));
}

export function newSpanId(): string {
  return hex(randomBytes(8));
}
