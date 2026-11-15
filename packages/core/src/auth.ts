/**
 * End-user auth contract shared by the SDK server wrapper (which implements
 * the routes) and `plat dev` (which swaps in a local sign-in page). Sessions
 * are Cognito tokens in HttpOnly cookies scoped to the app's own host.
 */
export const AUTH_ROUTES = {
  login: '/__platform/auth/login',
  callback: '/__platform/auth/callback',
  logout: '/__platform/auth/logout',
  me: '/__platform/auth/me',
} as const;

export const AUTH_COOKIES = {
  /** Cognito ID token (JWT). */
  id: '__plat_id',
  /** Cognito refresh token. */
  refresh: '__plat_rt',
  /** PKCE verifier + state + post-login redirect, during the login round trip. */
  flow: '__plat_flow',
} as const;

export const AUTH_SCOPES = ['openid', 'email', 'profile'] as const;

/** Backslashes, spaces, and ASCII control characters (`<= ' '` covers C0 and space). */
const unsafeInRedirect = (c: string) => c === '\\' || c <= ' ' || c === '\u007f';

/**
 * Only same-origin absolute paths are allowed as post-login destinations.
 * Browsers drop tabs and newlines from URLs (`/\t/evil.com` becomes
 * `//evil.com`), so control characters and spaces are refused too.
 */
export function safeRedirect(target: string | null | undefined): string {
  if (!target?.startsWith('/') || target.startsWith('//') || [...target].some(unsafeInRedirect)) return '/';
  return target;
}

/** Path that starts sign-in and returns to `redirect` afterwards. */
export function loginPath(redirect = '/'): string {
  return `${AUTH_ROUTES.login}?redirect=${encodeURIComponent(safeRedirect(redirect))}`;
}

/** Path that signs out and then goes to `redirect`. */
export function logoutPath(redirect = '/'): string {
  return `${AUTH_ROUTES.logout}?redirect=${encodeURIComponent(safeRedirect(redirect))}`;
}

/**
 * Body of every platform 401 (the `auth.required` gate, `auth.requireUser`
 * and the Effect SDK's `Unauthorized` error), so clients decode one shape.
 */
export const UNAUTHORIZED_BODY = {
  _tag: 'Unauthorized',
  message: 'Sign in required',
  loginUrl: AUTH_ROUTES.login,
} as const;

/** The user object apps see. */
export interface PlatformUser {
  /** Stable user id (Cognito `sub`). Same across all platform apps. */
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Cognito groups, e.g. `foo:admin`. */
  groups: string[];
}
