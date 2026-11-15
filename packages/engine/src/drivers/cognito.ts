import {
  CreateManagedLoginBrandingCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DeleteUserPoolClientCommand,
  DescribeUserPoolDomainCommand,
  type ExplicitAuthFlowsType,
  ListUserPoolClientsCommand,
  ListUserPoolsCommand,
  UpdateUserPoolClientCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AUTH_SCOPES } from '@eric-minassian/platform-core';
import { type EngineContext, errorName, ignoreNotFound, isNotImplemented, retry } from '../util.ts';

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
  callbackUrls: string[];
  logoutUrls: string[];
  /** Also allow password flows (the local sign-in page under `plat dev`). */
  passwordFlows?: boolean;
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

/** Public app client (no secret) for the authorization-code + PKCE flow. */
export async function ensureUserPoolClient(ctx: EngineContext, spec: UserPoolClientSpec): Promise<string> {
  const cognito = ctx.clients.cognito;
  const flows: ExplicitAuthFlowsType[] = ['ALLOW_REFRESH_TOKEN_AUTH'];
  if (spec.passwordFlows) flows.push('ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH');
  const config = {
    UserPoolId: spec.userPoolId,
    ClientName: spec.name,
    ExplicitAuthFlows: flows,
    AllowedOAuthFlows: ['code' as const],
    AllowedOAuthScopes: [...AUTH_SCOPES],
    AllowedOAuthFlowsUserPoolClient: true,
    CallbackURLs: spec.callbackUrls,
    LogoutURLs: spec.logoutUrls,
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

/**
 * Managed login (v2) on a custom domain. Returns the CloudFront domain Route 53
 * must alias the custom domain to. The certificate must be in us-east-1.
 */
export async function ensureUserPoolDomain(
  ctx: EngineContext,
  spec: { userPoolId: string; domain: string; certificateArn: string },
): Promise<string | undefined> {
  const cognito = ctx.clients.cognito;
  const existing = await cognito.send(new DescribeUserPoolDomainCommand({ Domain: spec.domain }));
  if (existing.DomainDescription?.UserPoolId) {
    if (existing.DomainDescription.UserPoolId !== spec.userPoolId) {
      throw new Error(`domain ${spec.domain} belongs to another user pool`);
    }
    return existing.DomainDescription.CloudFrontDistribution;
  }
  // Cognito requires the parent domain to resolve to an A record before it
  // accepts a custom domain. On a first run the parent is an alias to a
  // CloudFront distribution created moments earlier, which resolves only once
  // the distribution has deployed (several minutes), so keep retrying.
  let waiting = false;
  const res = await retry(
    () =>
      cognito.send(
        new CreateUserPoolDomainCommand({
          Domain: spec.domain,
          UserPoolId: spec.userPoolId,
          ManagedLoginVersion: 2,
          CustomDomainConfig: { CertificateArn: spec.certificateArn },
        }),
      ),
    {
      attempts: 120,
      delayMs: 5_000,
      when: (e) => {
        const parentMissing = /resolve a DNS A record for the parent domain/i.test(
          String((e as Error).message),
        );
        if (parentMissing && !waiting) {
          waiting = true;
          ctx.log('info', `waiting for the parent of ${spec.domain} to resolve (CloudFront still deploying)`);
        }
        return parentMissing;
      },
    },
  );
  ctx.log('info', 'created managed login domain', `user-pool-domain ${spec.domain}`);
  return res.CloudFrontDomain;
}
