import { hc } from 'hono/client';
import type { ApiType } from '../../src/server.ts';

/** Typed API client: routes, params and JSON bodies come from src/server.ts. */
export const api = hc<ApiType>('/api');

/** Platform-provided sign-in/out routes (same origin, cookie session). */
export const signInUrl = (redirect = window.location.pathname) =>
  `/__platform/auth/login?redirect=${encodeURIComponent(redirect)}`;
export const signOutUrl = (redirect = '/') =>
  `/__platform/auth/logout?redirect=${encodeURIComponent(redirect)}`;
