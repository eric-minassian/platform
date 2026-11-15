/**
 * GitHub API calls: identify a user from a token, the console's OAuth round
 * trip (GitHub App user authorization), and opening issues as the GitHub App.
 */
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import type { GithubAppSettings } from './config.ts';

const API = 'https://api.github.com';
const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'platform-control-plane',
});

export async function githubLogin(token: string): Promise<string> {
  const res = await fetch(`${API}/user`, { headers: headers(token), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GitHub rejected the token (${res.status})`);
  const body = (await res.json()) as { login?: string };
  if (!body.login) throw new Error('GitHub returned no login');
  return body.login;
}

export function authorizeUrl(app: GithubAppSettings, redirectUri: string, state: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  return u.toString();
}

export async function exchangeCode(
  app: GithubAppSettings,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new Error(body.error_description ?? 'GitHub did not return an access token');
  return body.access_token;
}

async function installationToken(app: GithubAppSettings): Promise<string | null> {
  if (!app.appId || !app.privateKey || !app.installationId) return null;
  // GitHub App keys are PKCS#1 PEM; node:crypto parses both PKCS#1 and PKCS#8.
  const key = createPrivateKey(app.privateKey);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(app.appId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 540)
    .sign(key);
  const res = await fetch(`${API}/app/installations/${app.installationId}/access_tokens`, {
    method: 'POST',
    headers: headers(jwt),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub App token request failed (${res.status})`);
  return ((await res.json()) as { token: string }).token;
}

/** Opens an issue in `repo` as the GitHub App. Returns the issue URL, or null if the App isn't configured. */
export async function openIssue(
  app: GithubAppSettings,
  repo: string,
  issue: { title: string; body: string; labels?: string[] },
): Promise<string | null> {
  const token = await installationToken(app);
  if (!token) return null;
  const res = await fetch(`${API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify(issue),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`creating an issue in ${repo} failed (${res.status})`);
  return ((await res.json()) as { html_url: string }).html_url;
}
