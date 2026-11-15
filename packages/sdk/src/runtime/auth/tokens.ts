import { randomBytes } from 'node:crypto';
import type { AuthBindings, PlatformUser } from '@ericminassian/platform-core';
import { createRemoteJWKSet, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose';
import { client } from '../clients.ts';

export interface Tokens {
  idToken: string;
  refreshToken?: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), { cooldownDuration: 30_000, cacheMaxAge: 3_600_000 });
    jwksCache.set(uri, set);
  }
  return set;
}

/** Verify a Cognito ID (or access) token for this app's client and map it to a user. */
export async function verifyToken(auth: AuthBindings, token: string): Promise<PlatformUser> {
  const { payload } = await jwtVerify(token, jwks(auth.jwksUri), { issuer: auth.issuer });
  const use = payload.token_use;
  if (use === 'id') {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(auth.clientId))
      throw new joseErrors.JWTClaimValidationFailed('unexpected "aud" claim value', payload, 'aud');
  } else if (use === 'access') {
    if (payload.client_id !== auth.clientId)
      throw new joseErrors.JWTClaimValidationFailed(
        'unexpected "client_id" claim value',
        payload,
        'client_id',
      );
  } else {
    throw new joseErrors.JWTClaimValidationFailed('unexpected "token_use" claim value', payload, 'token_use');
  }
  return toUser(payload);
}

export function isExpiredError(e: unknown): boolean {
  return e instanceof joseErrors.JWTExpired;
}

export function toUser(p: JWTPayload): PlatformUser {
  const str = (k: string) => (typeof p[k] === 'string' ? p[k] : undefined);
  const name =
    str('name') ?? ([str('given_name'), str('family_name')].filter(Boolean).join(' ') || undefined);
  const groups = Array.isArray(p['cognito:groups']) ? (p['cognito:groups'] as unknown[]).map(String) : [];
  const user: PlatformUser = { id: String(p.sub), groups };
  const email = str('email');
  if (email) user.email = email;
  if (p.email_verified !== undefined)
    user.emailVerified = p.email_verified === true || p.email_verified === 'true';
  if (name) user.name = name;
  return user;
}

// ---------------------------------------------------------------- hosted login (cognito mode)

async function tokenRequest(auth: AuthBindings, params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${auth.loginUrl.replace(/\/$/, '')}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: auth.clientId, ...params }),
  });
  if (!res.ok)
    throw new Error(`Cognito token endpoint returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { id_token?: string; refresh_token?: string };
  if (!json.id_token) throw new Error('Cognito token endpoint returned no id_token');
  return { idToken: json.id_token, ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}) };
}

export function exchangeCode(
  auth: AuthBindings,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<Tokens> {
  return tokenRequest(auth, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
}

export async function refreshTokens(auth: AuthBindings, refreshToken: string): Promise<Tokens> {
  if (auth.mode === 'local') {
    const { InitiateAuthCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    const cognito = await client('cognito');
    const out = await cognito.send(
      new InitiateAuthCommand({
        ClientId: auth.clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }),
    );
    const id = out.AuthenticationResult?.IdToken;
    if (!id) throw new Error('refresh returned no id token');
    return { idToken: id };
  }
  return tokenRequest(auth, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

// ---------------------------------------------------------------- local sign-in (plat dev)

function errorName(e: unknown): string {
  return (e as { name?: string })?.name ?? '';
}

/**
 * `plat dev` sign-in against the AWS Emulator's Cognito (no hosted UI there):
 * create the user if needed, set a throwaway password, and authenticate.
 */
export async function localSignIn(auth: AuthBindings, email: string, name?: string): Promise<Tokens> {
  const cognito = await client('cognito');
  const {
    AdminCreateUserCommand,
    AdminInitiateAuthCommand,
    AdminSetUserPasswordCommand,
    InitiateAuthCommand,
  } = await import('@aws-sdk/client-cognito-identity-provider');
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: auth.userPoolId,
        Username: email,
        MessageAction: 'SUPPRESS',
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          ...(name ? [{ Name: 'name', Value: name }] : []),
        ],
      }),
    );
  } catch (e) {
    if (errorName(e) !== 'UsernameExistsException') throw e;
  }
  const password = `Pp1!${randomBytes(18).toString('base64url')}`;
  await cognito.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: auth.userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }),
  );
  const params = { USERNAME: email, PASSWORD: password };
  let result: { IdToken?: string; RefreshToken?: string } | undefined;
  try {
    const out = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: auth.userPoolId,
        ClientId: auth.clientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: params,
      }),
    );
    result = out.AuthenticationResult;
  } catch {
    const out = await cognito.send(
      new InitiateAuthCommand({
        ClientId: auth.clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: params,
      }),
    );
    result = out.AuthenticationResult;
  }
  if (!result?.IdToken) throw new Error('Local sign-in returned no tokens');
  return { idToken: result.IdToken, ...(result.RefreshToken ? { refreshToken: result.RefreshToken } : {}) };
}
