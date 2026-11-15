import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getBindings } from './bindings.ts';

/**
 * Opaque `db` query cursors. A cursor is DynamoDB's `LastEvaluatedKey`
 * sealed with AES-256-GCM under a key derived from the stage key, with the
 * query's key condition as associated data. So a cursor hides the table's
 * key layout, and one that was edited, issued by another stage, or issued for
 * a different collection, index, partition or sort condition fails to open
 * before anything reaches DynamoDB.
 *
 * Layout (base64url): version (1 byte) · IV (12) · ciphertext · tag (16).
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A query got a cursor it didn't issue: malformed, edited, or from another
 * query. The server wrapper answers it with a 400 `invalid_cursor` and records
 * no error, since it's the caller's input. Catch it to answer differently.
 */
export class InvalidCursorError extends Error {
  override name = 'InvalidCursorError';
  readonly status = 400;
  readonly code = 'invalid_cursor';
  constructor() {
    super('Invalid cursor: pass back a cursor this query returned, with the same partition and conditions');
  }
}

let derived: { stageKey: string; key: Buffer } | undefined;

function cursorKey(): Buffer {
  const { stageKey } = getBindings();
  if (!stageKey) {
    throw new Error(
      'This stage has no stage key, so db query cursors are unavailable. Redeploy it (under `plat dev`, upgrade @ericminassian/plat).',
    );
  }
  if (derived?.stageKey !== stageKey) {
    const key = hkdfSync(
      'sha256',
      Buffer.from(stageKey, 'base64url'),
      Buffer.alloc(0),
      'platform:db-cursor:v1',
      32,
    );
    derived = { stageKey, key: Buffer.from(key) };
  }
  return derived.key;
}

function aad(scope: string): Buffer {
  return Buffer.concat([Buffer.of(VERSION), Buffer.from(scope, 'utf8')]);
}

/** Seal `lastKey` for the query identified by `scope`. */
export function sealCursor(lastKey: Record<string, unknown>, scope: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', cursorKey(), iv);
  cipher.setAAD(aad(scope));
  const body = Buffer.concat([cipher.update(JSON.stringify(lastKey), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), iv, body, cipher.getAuthTag()]).toString('base64url');
}

/** The `ExclusiveStartKey` inside a cursor sealed for `scope`; throws {@link InvalidCursorError} otherwise. */
export function openCursor(cursor: unknown, scope: string): Record<string, unknown> {
  const key = cursorKey();
  if (typeof cursor !== 'string') throw new InvalidCursorError();
  const raw = Buffer.from(cursor, 'base64url');
  if (raw.length < 1 + IV_BYTES + TAG_BYTES + 1 || raw[0] !== VERSION) throw new InvalidCursorError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad(scope));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(raw.subarray(1 + IV_BYTES, raw.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new InvalidCursorError();
  }
}
