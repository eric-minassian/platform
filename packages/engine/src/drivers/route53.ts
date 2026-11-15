import {
  type Change,
  ChangeResourceRecordSetsCommand,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  ListHostedZonesByNameCommand,
} from '@aws-sdk/client-route-53';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { type EngineContext, platformTags } from '../util.ts';
import { CLOUDFRONT_HOSTED_ZONE_ID } from './cloudfront.ts';

const fqdn = (name: string) => (name.endsWith('.') ? name : `${name}.`);

/**
 * Public zone id by name using only `ListHostedZonesByName`: that is all the
 * cross-account delegation role in github.com/eric-minassian/aws may call.
 */
export async function findHostedZoneId(
  ctx: Pick<EngineContext, 'clients'>,
  name: string,
): Promise<string | undefined> {
  const res = await ctx.clients.route53.send(
    new ListHostedZonesByNameCommand({ DNSName: fqdn(name), MaxItems: 1 }),
  );
  const zone = (res.HostedZones ?? []).find((z) => z.Name === fqdn(name) && !z.Config?.PrivateZone);
  return zone?.Id?.replace('/hostedzone/', '');
}

export async function findHostedZone(
  ctx: Pick<EngineContext, 'clients'>,
  name: string,
): Promise<{ id: string; nameServers: string[] } | undefined> {
  const id = await findHostedZoneId(ctx, name);
  if (!id) return undefined;
  const details = await ctx.clients.route53.send(new GetHostedZoneCommand({ Id: id }));
  return { id, nameServers: details.DelegationSet?.NameServers ?? [] };
}

export async function ensureHostedZone(
  ctx: EngineContext,
  name: string,
): Promise<{ id: string; nameServers: string[] }> {
  const existing = await findHostedZone(ctx, name);
  if (existing) return existing;
  const res = await ctx.clients.route53.send(
    new CreateHostedZoneCommand({
      Name: name,
      CallerReference: `${name}-${Date.now()}`,
      HostedZoneConfig: { Comment: `platform (${JSON.stringify(platformTags('dns'))})` },
    }),
  );
  ctx.log('info', 'created hosted zone', `zone ${name}`);
  return {
    id: res.HostedZone!.Id!.replace('/hostedzone/', ''),
    nameServers: res.DelegationSet?.NameServers ?? [],
  };
}

export async function upsertRecords(
  ctx: Pick<EngineContext, 'clients'>,
  zoneId: string,
  changes: Change[],
): Promise<void> {
  if (!changes.length) return;
  await ctx.clients.route53.send(
    new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Changes: changes } }),
  );
}

/** A + AAAA alias records pointing `name` at a CloudFront distribution domain. */
export function cloudFrontAlias(name: string, distributionDomain: string): Change[] {
  return (['A', 'AAAA'] as const).map((Type) => ({
    Action: 'UPSERT' as const,
    ResourceRecordSet: {
      Name: fqdn(name),
      Type,
      AliasTarget: {
        DNSName: distributionDomain,
        HostedZoneId: CLOUDFRONT_HOSTED_ZONE_ID,
        EvaluateTargetHealth: false,
      },
    },
  }));
}

export function cnameRecord(name: string, value: string, ttl = 300): Change {
  return {
    Action: 'UPSERT',
    ResourceRecordSet: { Name: fqdn(name), Type: 'CNAME', TTL: ttl, ResourceRecords: [{ Value: value }] },
  };
}

/**
 * Register `zoneName`'s NS records in its parent zone, which lives in another
 * account (github.com/eric-minassian/aws). That account grants a role that may
 * UPSERT exactly this NS record and nothing else.
 */
export async function delegateZone(
  ctx: EngineContext,
  spec: { roleArn: string; parentZoneName: string; zoneName: string; nameServers: string[] },
): Promise<void> {
  const assumed = await ctx.clients.sts.send(
    new AssumeRoleCommand({
      RoleArn: spec.roleArn,
      RoleSessionName: 'platform-dns-delegation',
      DurationSeconds: 900,
    }),
  );
  const c = assumed.Credentials!;
  const parent = ctx.clients.withCredentials({
    accessKeyId: c.AccessKeyId!,
    secretAccessKey: c.SecretAccessKey!,
    sessionToken: c.SessionToken!,
  });
  const parentId = await findHostedZoneId({ clients: parent }, spec.parentZoneName);
  if (!parentId) throw new Error(`parent zone ${spec.parentZoneName} not visible to ${spec.roleArn}`);
  await upsertRecords({ clients: parent }, parentId, [
    {
      Action: 'UPSERT',
      ResourceRecordSet: {
        Name: fqdn(spec.zoneName),
        Type: 'NS',
        TTL: 172800,
        ResourceRecords: spec.nameServers.map((Value) => ({ Value })),
      },
    },
  ]);
  ctx.log('info', `delegated ${spec.zoneName} from ${spec.parentZoneName}`, `zone ${spec.zoneName}`);
}
