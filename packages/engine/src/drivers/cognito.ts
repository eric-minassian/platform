import { isDeepStrictEqual } from 'node:util';
import {
  type AssetType,
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteManagedLoginBrandingCommand,
  DeleteUserPoolClientCommand,
  DescribeManagedLoginBrandingByClientCommand,
  type ExplicitAuthFlowsType,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  UpdateManagedLoginBrandingCommand,
  UpdateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AUTH_SCOPES } from '@ericminassian/platform-core';
import type { LoginBranding } from '../login-branding.ts';
import { type EngineContext, ignoreNotFound } from '../util.ts';

/** Shared user pool for app end users: email sign-in, self sign-up, Essentials tier (managed login). */
export async function ensureUserPool(
  ctx: EngineContext,
  spec: { name: string; tags?: Record<string, string> },
): Promise<string> {
  const cognito = ctx.clients.cognito;
  let NextToken: string | undefined;
  do {
    const res = await cognito.send(new ListUserPoolsCommand({ MaxResults: 60, NextToken }));
    const found = (res.UserPools ?? []).find((p) => p.Name === spec.name);
    if (found?.Id) return found.Id;
    NextToken = res.NextToken;
  } while (NextToken);
  const res = await cognito.send(
    new CreateUserPoolCommand({
      PoolName: spec.name,
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      Policies: {
        PasswordPolicy: {
          MinimumLength: 10,
          RequireLowercase: false,
          RequireUppercase: false,
          RequireNumbers: false,
          RequireSymbols: false,
        },
      },
      UserPoolTier: ctx.target === 'aws' ? 'ESSENTIALS' : undefined,
      DeletionProtection: ctx.target === 'aws' ? 'ACTIVE' : 'INACTIVE',
      UserPoolTags: spec.tags,
    }),
  );
  ctx.log('info', 'created user pool', `user-pool ${spec.name}`);
  return res.UserPool!.Id!;
}

export interface UserPoolClientSpec {
  userPoolId: string;
  name: string;
  /** Where managed login returns after sign-in and sign-out (AWS only). */
  callbackUrls: string[];
  logoutUrls: string[];
}

export async function findUserPoolClient(
  ctx: EngineContext,
  userPoolId: string,
  name: string,
): Promise<string | undefined> {
  let NextToken: string | undefined;
  do {
    const res = await ignoreNotFound(
      ctx.clients.cognito.send(
        new ListUserPoolClientsCommand({ UserPoolId: userPoolId, MaxResults: 60, NextToken }),
      ),
    );
    if (!res) return undefined;
    const found = (res.UserPoolClients ?? []).find((c) => c.ClientName === name);
    if (found?.ClientId) return found.ClientId;
    NextToken = res.NextToken;
  } while (NextToken);
  return undefined;
}

/**
 * Public app client (no secret). On AWS it signs in through managed login
 * (authorization code + PKCE). The emulator has no managed login, and `plat
 * dev`'s own sign-in page uses password flows instead, so its client has no
 * OAuth settings. It couldn't have them anyway: like Cognito, the emulator
 * (1.0.610 at least) refuses http callback URLs other than localhost's, and a
 * local app is on `http://<app>.localhost`.
 */
export async function ensureUserPoolClient(ctx: EngineContext, spec: UserPoolClientSpec): Promise<string> {
  const cognito = ctx.clients.cognito;
  const flows: ExplicitAuthFlowsType[] = ['ALLOW_REFRESH_TOKEN_AUTH'];
  if (ctx.target !== 'aws') flows.push('ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH');
  const config = {
    UserPoolId: spec.userPoolId,
    ClientName: spec.name,
    ExplicitAuthFlows: flows,
    ...(ctx.target === 'aws'
      ? {
          AllowedOAuthFlows: ['code' as const],
          AllowedOAuthScopes: [...AUTH_SCOPES],
          AllowedOAuthFlowsUserPoolClient: true,
          CallbackURLs: spec.callbackUrls,
          LogoutURLs: spec.logoutUrls,
        }
      : {}),
    SupportedIdentityProviders: ['COGNITO'],
    PreventUserExistenceErrors: 'ENABLED' as const,
    EnableTokenRevocation: true,
    AccessTokenValidity: 60,
    IdTokenValidity: 60,
    RefreshTokenValidity: 30,
    TokenValidityUnits: {
      AccessToken: 'minutes' as const,
      IdToken: 'minutes' as const,
      RefreshToken: 'days' as const,
    },
  };
  const existing = await findUserPoolClient(ctx, spec.userPoolId, spec.name);
  if (existing) {
    await cognito.send(new UpdateUserPoolClientCommand({ ...config, ClientId: existing }));
    return existing;
  }
  const res = await cognito.send(new CreateUserPoolClientCommand({ ...config, GenerateSecret: false }));
  const clientId = res.UserPoolClient!.ClientId!;
  ctx.log('info', 'created app client', `user-pool-client ${spec.name}`);
  return clientId;
}

/**
 * Gives a client's managed login pages `branding`, on every deploy, so a
 * changed style reaches clients made before it. Managed login (v2) renders a
 * client's pages only once it has a style. AWS only: the emulator has no
 * managed login (and mis-serializes these responses).
 *
 * Cognito stores exactly what it's sent, so an unchanged style costs one read.
 * An update replaces the settings but merges the assets: an asset the new
 * style no longer has can only go with the style, so then it's recreated.
 * Either way the pages pick it up a minute or two later.
 */
export async function ensureLoginBranding(
  ctx: EngineContext,
  spec: { userPoolId: string; clientId: string; name: string; branding: LoginBranding },
): Promise<void> {
  const cognito = ctx.clients.cognito;
  const { userPoolId, clientId, branding } = spec;
  const current = (
    await ignoreNotFound(
      cognito.send(
        new DescribeManagedLoginBrandingByClientCommand({ UserPoolId: userPoolId, ClientId: clientId }),
      ),
    )
  )?.ManagedLoginBranding;
  const style = {
    UserPoolId: userPoolId,
    UseCognitoProvidedValues: false,
    Settings: branding.settings,
    Assets: branding.assets,
  };
  const create = () => cognito.send(new CreateManagedLoginBrandingCommand({ ...style, ClientId: clientId }));
  if (!current?.ManagedLoginBrandingId) {
    await create();
    ctx.log('info', 'styled managed login', `user-pool-client ${spec.name}`);
    return;
  }
  const key = (a: AssetType) => `${a.Category}/${a.ColorMode}`;
  const wanted = new Map(branding.assets.map((a) => [key(a), a]));
  const stored = current.Assets ?? [];
  const sameAssets =
    stored.length === wanted.size &&
    stored.every((a) => {
      const w = wanted.get(key(a));
      return (
        w !== undefined &&
        w.Extension === a.Extension &&
        a.Bytes !== undefined &&
        Buffer.from(w.Bytes).equals(a.Bytes)
      );
    });
  if (
    !current.UseCognitoProvidedValues &&
    sameAssets &&
    isDeepStrictEqual(current.Settings, branding.settings)
  )
    return;
  if (stored.some((a) => !wanted.has(key(a)))) {
    await cognito.send(
      new DeleteManagedLoginBrandingCommand({
        UserPoolId: userPoolId,
        ManagedLoginBrandingId: current.ManagedLoginBrandingId,
      }),
    );
    await create();
  } else {
    await cognito.send(
      new UpdateManagedLoginBrandingCommand({
        ...style,
        ManagedLoginBrandingId: current.ManagedLoginBrandingId,
      }),
    );
  }
  ctx.log('info', 'restyled managed login', `user-pool-client ${spec.name}`);
}

export async function deleteUserPoolClient(
  ctx: EngineContext,
  userPoolId: string,
  name: string,
): Promise<boolean> {
  const id = await findUserPoolClient(ctx, userPoolId, name);
  if (!id) return false;
  await ignoreNotFound(
    ctx.clients.cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: id })),
  );
  ctx.log('info', 'deleted app client', `user-pool-client ${name}`);
  return true;
}
