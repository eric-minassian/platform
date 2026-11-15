import { getBindings } from './bindings.ts';

export interface AppInfo {
  name: string;
  stage: string;
  host: string;
  url: string;
  revision: string;
  isLocal: boolean;
}

/** Facts about the running app stage (lazy: read from bindings on access). */
export const app: AppInfo = {
  get name() {
    return getBindings().app;
  },
  get stage() {
    return getBindings().stage;
  },
  get host() {
    return getBindings().host;
  },
  get url() {
    return getBindings().url;
  },
  get revision() {
    return getBindings().revision;
  },
  get isLocal() {
    return process.env.PLATFORM_LOCAL === '1';
  },
};
