import type { RouteRecord } from '../router.ts';

export type RouteDecision = { t: 'server' } | { t: 'static'; key: string } | { t: 'notfound' };

export declare function decide(rec: RouteRecord | null | undefined, uri: string): RouteDecision;
