import {
  CreateConfigurationSetCommand,
  CreateEmailIdentityCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteConfigurationSetCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  GetConfigurationSetCommand,
  type GetConfigurationSetCommandOutput,
  GetEmailIdentityCommand,
  GetTenantCommand,
  ListTenantResourcesCommand,
  PutConfigurationSetReputationOptionsCommand,
  PutTenantSuppressionAttributesCommand,
  type Tag,
  TagResourceCommand,
  type Tenant,
  type TenantSuppressionAttributes,
} from '@aws-sdk/client-sesv2';
import { configurationSetArn, emailIdentityArn } from '../policy.ts';
import { type EngineContext, ignoreNotFound, tagList } from '../util.ts';

/**
 * Amazon SES: each stage that declares `email` is a tenant plus a
 * configuration set, both named `names.emailTenant`, associated with the
 * platform's one domain identity (the foundation stack verifies it; the
 * emulator's comes from `ensureLocal`). Found by name, like everything else
 * the engine owns.
 *
 * The tenant is what isolates apps from each other: SES keeps its own
 * suppression list, reports its metrics, and pauses only it when its
 * reputation policy (SES's default, `standard`) sees too many bounces or
 * complaints.
 */

/** Every stage tenant keeps its own list, fed by hard bounces and complaints. */
export const TENANT_SUPPRESSION = {
  SuppressedReasons: ['BOUNCE', 'COMPLAINT'],
  SuppressionScope: 'TENANT',
} as const satisfies TenantSuppressionAttributes;

export interface TenantState {
  name: string;
  id: string;
  arn: string;
}

// ---------------------------------------------------------------- configuration sets

export async function getConfigurationSet(
  ctx: EngineContext,
  name: string,
): Promise<GetConfigurationSetCommandOutput | undefined> {
  return ignoreNotFound(ctx.clients.ses.send(new GetConfigurationSetCommand({ ConfigurationSetName: name })));
}

/**
 * The stage's configuration set, with reputation metrics on (they feed the
 * console's bounce and complaint rates). Sends name it with the tenant, which
 * is also what the stage role's grant covers.
 */
export async function ensureConfigurationSet(
  ctx: EngineContext,
  spec: { name: string; tags: Record<string, string> },
): Promise<{ name: string; arn: string }> {
  const arn = configurationSetArn(ctx.region, await ctx.accountId(), spec.name);
  const existing = await getConfigurationSet(ctx, spec.name);
  if (!existing) {
    await ctx.clients.ses.send(
      new CreateConfigurationSetCommand({
        ConfigurationSetName: spec.name,
        ReputationOptions: { ReputationMetricsEnabled: true },
        Tags: tagList(spec.tags),
      }),
    );
    ctx.log('info', 'created configuration set', `configuration-set ${spec.name}`);
    return { name: spec.name, arn };
  }
  if (!existing.ReputationOptions?.ReputationMetricsEnabled) {
    await ctx.clients.ses.send(
      new PutConfigurationSetReputationOptionsCommand({
        ConfigurationSetName: spec.name,
        ReputationMetricsEnabled: true,
      }),
    );
    ctx.log('info', 'turned on reputation metrics', `configuration-set ${spec.name}`);
  }
  await ensureTags(ctx, arn, existing.Tags, spec.tags);
  return { name: spec.name, arn };
}

export async function deleteConfigurationSet(ctx: EngineContext, name: string): Promise<boolean> {
  const res = await ignoreNotFound(
    ctx.clients.ses.send(new DeleteConfigurationSetCommand({ ConfigurationSetName: name })),
  );
  if (res === undefined) return false;
  ctx.log('info', 'deleted configuration set', `configuration-set ${name}`);
  return true;
}

// ---------------------------------------------------------------- tenants

export async function getTenant(ctx: EngineContext, name: string): Promise<TenantState | undefined> {
  const res = await ignoreNotFound(ctx.clients.ses.send(new GetTenantCommand({ TenantName: name })));
  return res?.Tenant ? tenantState(res.Tenant) : undefined;
}

/**
 * The stage's tenant, created with the platform's suppression settings. An
 * existing one keeps its id (and so its suppression list, metrics and any
 * pause); only its tags and suppression settings are brought in line.
 */
export async function ensureTenant(
  ctx: EngineContext,
  spec: { name: string; tags: Record<string, string> },
): Promise<TenantState> {
  const existing = await ignoreNotFound(
    ctx.clients.ses.send(new GetTenantCommand({ TenantName: spec.name })),
  );
  if (!existing?.Tenant) {
    const created = await ctx.clients.ses.send(
      new CreateTenantCommand({
        TenantName: spec.name,
        Tags: tagList(spec.tags),
        SuppressionAttributes: TENANT_SUPPRESSION,
      }),
    );
    ctx.log('info', 'created tenant', `email-tenant ${spec.name}`);
    // Checked rather than assumed: a tenant left on the account's list would share
    // suppressions (and their reputation cost) with every other app.
    if (!sameSuppression(created.SuppressionAttributes)) await putTenantSuppression(ctx, spec.name);
    return tenantState(created);
  }
  const state = tenantState(existing.Tenant);
  await ensureTags(ctx, state.arn, existing.Tenant.Tags, spec.tags);
  if (!sameSuppression(existing.Tenant.SuppressionAttributes)) await putTenantSuppression(ctx, spec.name);
  return state;
}

/** Point the tenant at its own suppression list (`TENANT_SUPPRESSION`). */
export async function putTenantSuppression(ctx: EngineContext, name: string): Promise<void> {
  await ctx.clients.ses.send(
    new PutTenantSuppressionAttributesCommand({ TenantName: name, ...TENANT_SUPPRESSION }),
  );
  ctx.log('info', 'tenant keeps its own suppression list', `email-tenant ${name}`);
}

/** ARNs of everything associated with the tenant (identities, configuration sets, templates). */
export async function listTenantResources(ctx: EngineContext, name: string): Promise<string[]> {
  const out: string[] = [];
  let NextToken: string | undefined;
  do {
    const res = await ctx.clients.ses.send(
      new ListTenantResourcesCommand({ TenantName: name, ...(NextToken ? { NextToken } : {}) }),
    );
    for (const r of res.TenantResources ?? []) if (r.ResourceArn) out.push(r.ResourceArn);
    NextToken = res.NextToken;
  } while (NextToken);
  return out;
}

/**
 * Associate exactly `resourceArns` (the domain identity and the stage's
 * configuration set) with the tenant: a send that names the tenant may only
 * use resources associated with it. SES refuses a second association of the
 * same resource (AlreadyExists), so this lists first.
 */
export async function ensureTenantResources(
  ctx: EngineContext,
  name: string,
  resourceArns: readonly string[],
): Promise<void> {
  const current = new Set(await listTenantResources(ctx, name));
  for (const arn of resourceArns) {
    if (current.has(arn)) continue;
    await ctx.clients.ses.send(
      new CreateTenantResourceAssociationCommand({ TenantName: name, ResourceArn: arn }),
    );
    ctx.log('info', `associated ${arn.slice(arn.lastIndexOf(':') + 1)}`, `email-tenant ${name}`);
  }
  for (const arn of current) {
    if (resourceArns.includes(arn)) continue;
    await ignoreNotFound(
      ctx.clients.ses.send(
        new DeleteTenantResourceAssociationCommand({ TenantName: name, ResourceArn: arn }),
      ),
    );
    ctx.log('info', `dissociated ${arn.slice(arn.lastIndexOf(':') + 1)}`, `email-tenant ${name}`);
  }
}

/**
 * Delete the tenant (its suppression list and metrics go with it). Its
 * associations are removed first so the identity and configuration set are
 * free of it whatever SES does with them on delete.
 */
export async function deleteTenant(ctx: EngineContext, name: string): Promise<boolean> {
  const resources = await ignoreNotFound(listTenantResources(ctx, name));
  if (resources === undefined) return false;
  for (const arn of resources) {
    await ignoreNotFound(
      ctx.clients.ses.send(
        new DeleteTenantResourceAssociationCommand({ TenantName: name, ResourceArn: arn }),
      ),
    );
  }
  const res = await ignoreNotFound(ctx.clients.ses.send(new DeleteTenantCommand({ TenantName: name })));
  if (res === undefined) return false;
  ctx.log('info', 'deleted tenant', `email-tenant ${name}`);
  return true;
}

// ---------------------------------------------------------------- identities

/**
 * A domain identity, created when missing. Only `ensureLocal` uses this: in
 * AWS the foundation stack owns the identity and its DNS records. Returns its
 * ARN (SES doesn't report one).
 */
export async function ensureEmailIdentity(
  ctx: EngineContext,
  spec: { domain: string; tags: Record<string, string> },
): Promise<{ domain: string; arn: string }> {
  const arn = emailIdentityArn(ctx.region, await ctx.accountId(), spec.domain);
  const existing = await ignoreNotFound(
    ctx.clients.ses.send(new GetEmailIdentityCommand({ EmailIdentity: spec.domain })),
  );
  if (!existing) {
    await ctx.clients.ses.send(
      new CreateEmailIdentityCommand({ EmailIdentity: spec.domain, Tags: tagList(spec.tags) }),
    );
    ctx.log('info', 'created domain identity', `email-identity ${spec.domain}`);
  }
  return { domain: spec.domain, arn };
}

// ---------------------------------------------------------------- helpers

function tenantState(t: Pick<Tenant, 'TenantName' | 'TenantId' | 'TenantArn'>): TenantState {
  if (!t.TenantName || !t.TenantId || !t.TenantArn)
    throw new Error('SES returned a tenant without its name, id or ARN');
  return { name: t.TenantName, id: t.TenantId, arn: t.TenantArn };
}

function sameSuppression(a: TenantSuppressionAttributes | undefined): boolean {
  const reasons = (a?.SuppressedReasons ?? []).toSorted().join(',');
  return (
    a?.SuppressionScope === TENANT_SUPPRESSION.SuppressionScope &&
    reasons === TENANT_SUPPRESSION.SuppressedReasons.toSorted().join(',')
  );
}

/** Add or correct the platform's tags; tags someone else added stay. */
async function ensureTags(
  ctx: EngineContext,
  arn: string,
  current: Tag[] | undefined,
  wanted: Record<string, string>,
): Promise<void> {
  const have = new Map((current ?? []).map((t) => [t.Key, t.Value]));
  const missing = Object.entries(wanted).filter(([k, v]) => have.get(k) !== v);
  if (!missing.length) return;
  await ctx.clients.ses.send(
    new TagResourceCommand({ ResourceArn: arn, Tags: missing.map(([Key, Value]) => ({ Key, Value })) }),
  );
}
