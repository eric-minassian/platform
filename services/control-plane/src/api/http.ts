/**
 * The control plane's routes: `PlatformApi` (`/v1`) with its handlers, the
 * console's sign-in (`/auth`), and the error bodies the router answers
 * itself. Still needs the services the handlers call: `src/server.ts`
 * provides the AWS-backed ones, tests in-memory ones.
 */
import { PlatformApi } from '@ericminassian/platform-core/platform-api';
import { Layer } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { AuthenticatedLive } from '../auth.ts';
import { Access } from './access.ts';
import { AdminLive } from './admin.ts';
import { AlertsLive } from './alerts.ts';
import { AppsLive } from './apps.ts';
import { DeploymentsLive, StagesLive } from './deployments.ts';
import { RequestValidationLive, RouterErrorsLive } from './errors.ts';
import { ManageLive } from './manage.ts';
import { ObserveLive } from './observe.ts';
import { ConsoleSignInLive, SessionLive } from './session.ts';

export const HttpLive = Layer.mergeAll(
  HttpApiBuilder.layer(PlatformApi),
  ConsoleSignInLive,
  RouterErrorsLive,
).pipe(
  Layer.provide([
    SessionLive,
    AppsLive,
    StagesLive,
    DeploymentsLive,
    ObserveLive,
    AlertsLive,
    ManageLive,
    AdminLive,
  ]),
  Layer.provide([AuthenticatedLive, RequestValidationLive, Access.layer]),
);
