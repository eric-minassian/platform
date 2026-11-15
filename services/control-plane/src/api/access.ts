/**
 * Who may do what, for the handlers: the caller is `CurrentPrincipal` (from
 * `Authenticated`), and the rules are the pure ones in authz.ts.
 */
import {
  type AppRecord,
  type DeploymentRecord,
  PROD_STAGE,
  type ResolvedManifest,
  type StageRecord,
  validateStageName,
} from '@ericminassian/platform-core';
import {
  BadRequest,
  CurrentPrincipal,
  Forbidden,
  type MemberPrincipal,
  NotFound,
} from '@ericminassian/platform-core/platform-api';
import { Context, Effect, Layer, Option } from 'effect';
import { canAccessApp, checkStageAccess, type StageAction } from '../authz.ts';
import { Settings } from '../config.ts';
import { type DeploymentItem, type StageItem, Store } from '../store.ts';

export class Access extends Context.Service<
  Access,
  {
    /** The caller, who must be a member (not a CI run). */
    readonly member: Effect.Effect<MemberPrincipal, Forbidden, CurrentPrincipal>;
    /** The caller, who must be a platform admin. */
    readonly admin: Effect.Effect<MemberPrincipal, Forbidden, CurrentPrincipal>;
    /** An app the (member) caller may manage. Apps they can't see are "not found". */
    memberApp(
      name: string,
    ): Effect.Effect<
      { readonly app: AppRecord; readonly member: MemberPrincipal },
      Forbidden | NotFound,
      CurrentPrincipal
    >;
    /** An app for a stage-scoped action; members and (rule-checked) CI runs are allowed. */
    stageApp(
      name: string,
      stage: string,
      action?: StageAction,
    ): Effect.Effect<AppRecord, Forbidden | NotFound, CurrentPrincipal>;
    /** The manifest of the deployment live on a stage, if any. */
    liveManifest(app: string, stage: string): Effect.Effect<Option.Option<ResolvedManifest>>;
  }
>()('@ericminassian/platform-control-plane/Access') {
  static readonly layer: Layer.Layer<Access, never, Settings | Store> = Layer.effect(
    Access,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const store = yield* Store;

      const member = CurrentPrincipal.pipe(
        Effect.filterOrFail(
          (p): p is MemberPrincipal => p.kind === 'member',
          () => new Forbidden({ code: 'members_only', message: 'this endpoint needs a member token' }),
        ),
      );

      const admin = member.pipe(
        Effect.filterOrFail(
          (m) => m.role === 'admin',
          () => new Forbidden({ code: 'admins_only', message: 'this endpoint is for platform admins' }),
        ),
      );

      const memberApp = Effect.fn('Access.memberApp')(function* (name: string) {
        const me = yield* member;
        const app = yield* store.getApp(name);
        if (Option.isNone(app) || !canAccessApp(me, app.value)) return yield* NotFound.of(`app ${name}`);
        return { app: app.value, member: me };
      });

      const stageApp = Effect.fn('Access.stageApp')(function* (
        name: string,
        stage: string,
        action: StageAction = 'deploy',
      ) {
        const found = yield* store.getApp(name);
        if (Option.isNone(found)) return yield* NotFound.of(`app ${name}`);
        const app = found.value;
        const p = yield* CurrentPrincipal;
        const decision = checkStageAccess(p, app, stage, settings.platform, action);
        if (!decision.ok) {
          if (p.kind === 'member' && !canAccessApp(p, app)) return yield* NotFound.of(`app ${name}`);
          return yield* new Forbidden({ code: 'forbidden', message: decision.reason });
        }
        return app;
      });

      const liveManifest = Effect.fn('Access.liveManifest')(function* (app: string, stage: string) {
        const st = yield* store.getStage(app, stage);
        const current = Option.flatMapNullishOr(st, (s) => s.currentDeployment);
        if (Option.isNone(current)) return Option.none<ResolvedManifest>();
        const deployment = yield* store.getDeployment(current.value);
        return Option.flatMapNullishOr(deployment, (d) => d.manifest);
      });

      return Access.of({ member, admin, memberApp, stageApp, liveManifest });
    }),
  );
}

/** `?stage=` (default prod), validated. */
export const stageParam = (stage: string | undefined): Effect.Effect<string, BadRequest> => {
  const name = stage ?? PROD_STAGE;
  const err = validateStageName(name);
  return err ? Effect.fail(BadRequest.of(err)) : Effect.succeed(name);
};

/** What the API shows of a stage: no route records (they name internal origins) or pinger state. */
export const publicStage = ({
  route: _r,
  previousRoute: _p,
  up: _u,
  upChangedAt: _c,
  failures: _f,
  ...stage
}: StageItem): StageRecord => stage;

/** What the API shows of a deployment: no route record or revision. */
export const publicDeployment = ({
  route: _r,
  revisionId: _v,
  ...deployment
}: DeploymentItem): DeploymentRecord => deployment;
