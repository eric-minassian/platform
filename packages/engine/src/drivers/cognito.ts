import {
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  DeleteUserPoolClientCommand,
  type ExplicitAuthFlowsType,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  UpdateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AUTH_SCOPES } from '@ericminassian/platform-core';
import { type EngineContext, errorName, ignoreNotFound, isNotImplemented } from '../util.ts';

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
  // Managed login (v2) renders a client's pages only once it has a branding style.
  // The emulator has no hosted login (and mis-serializes this response), so skip it there.
  if (ctx.target !== 'aws') return clientId;
  try {
    await cognito.send(
      new CreateManagedLoginBrandingCommand({
        UserPoolId: spec.userPoolId,
        ClientId: clientId,
        UseCognitoProvidedValues: true,
      }),
    );
  } catch (e) {
    if (isNotImplemented(e))
      ctx.log('warn', 'managed login branding not supported here', `user-pool-client ${spec.name}`);
    else if (!/Exists|Conflict/.test(errorName(e))) throw e;
  }
  return clientId;
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
