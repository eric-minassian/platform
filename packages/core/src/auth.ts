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
