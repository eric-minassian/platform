import { createHash, randomBytes } from 'node:crypto';

/** RFC 7636 code verifier (43-128 chars of unreserved characters). */
export function createVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function randomState(): string {
  return randomBytes(16).toString('base64url');
}

export interface FlowState {
  /** PKCE verifier. */
  v: string;
  /** OAuth state. */
  s: string;
  /** Path to return to after sign-in. */
  r: string;
}

export function encodeFlow(f: FlowState): string {
  return Buffer.from(JSON.stringify(f)).toString('base64url');
}

export function decodeFlow(raw: string | undefined): FlowState | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FlowState;
    return typeof f.v === 'string' && typeof f.s === 'string' && typeof f.r === 'string' ? f : null;
  } catch {
    return null;
  }
}
