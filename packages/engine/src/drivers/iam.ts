import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePermissionsBoundaryCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  PutRolePermissionsBoundaryCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { type EngineContext, ignoreNotFound, type PolicyDocument, samePolicy, tagList } from '../util.ts';

export interface RoleSpec {
  name: string;
  path?: string;
  description?: string;
  trust: PolicyDocument;
  /** Inline policies by name; inline policies not listed are removed. */
  inlinePolicies?: Record<string, PolicyDocument>;
  managedPolicyArns?: string[];
  boundaryArn?: string;
  tags?: Record<string, string>;
  maxSessionDurationSeconds?: number;
}

export interface RoleState {
  arn: string;
  name: string;
  created: boolean;
}

export async function ensureRole(ctx: EngineContext, spec: RoleSpec): Promise<RoleState> {
  const iam = ctx.clients.iam;
  const existing = await ignoreNotFound(iam.send(new GetRoleCommand({ RoleName: spec.name })));
  let arn: string;
  let created = false;
  if (!existing?.Role) {
    const res = await iam.send(
      new CreateRoleCommand({
        RoleName: spec.name,
        Path: spec.path ?? '/',
        Description: spec.description,
        AssumeRolePolicyDocument: JSON.stringify(spec.trust),
        PermissionsBoundary: spec.boundaryArn,
        MaxSessionDuration: spec.maxSessionDurationSeconds,
        Tags: spec.tags ? tagList(spec.tags) : undefined,
      }),
    );
    arn = res.Role!.Arn!;
    created = true;
    ctx.log('info', 'created role', `role ${spec.name}`);
  } else {
    const role = existing.Role;
    arn = role.Arn!;
    if (!samePolicy(role.AssumeRolePolicyDocument, spec.trust)) {
      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: spec.name,
          PolicyDocument: JSON.stringify(spec.trust),
        }),
      );
    }
    const currentBoundary = role.PermissionsBoundary?.PermissionsBoundaryArn;
    if (spec.boundaryArn && currentBoundary !== spec.boundaryArn) {
      await iam.send(
        new PutRolePermissionsBoundaryCommand({ RoleName: spec.name, PermissionsBoundary: spec.boundaryArn }),
      );
    } else if (!spec.boundaryArn && currentBoundary) {
      await iam.send(new DeleteRolePermissionsBoundaryCommand({ RoleName: spec.name }));
    }
    if (spec.tags) await iam.send(new TagRoleCommand({ RoleName: spec.name, Tags: tagList(spec.tags) }));
  }

  const wanted = spec.inlinePolicies ?? {};
  for (const [policyName, doc] of Object.entries(wanted)) {
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: spec.name,
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(doc),
      }),
    );
  }
  const listed = await iam.send(new ListRolePoliciesCommand({ RoleName: spec.name }));
  for (const name of listed.PolicyNames ?? []) {
    if (!(name in wanted))
      await iam.send(new DeleteRolePolicyCommand({ RoleName: spec.name, PolicyName: name }));
  }

  if (spec.managedPolicyArns) {
    const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: spec.name }));
    const have = new Set((attached.AttachedPolicies ?? []).map((p) => p.PolicyArn!));
    for (const p of spec.managedPolicyArns) {
      if (!have.has(p)) await iam.send(new AttachRolePolicyCommand({ RoleName: spec.name, PolicyArn: p }));
    }
    for (const p of have) {
      if (!spec.managedPolicyArns.includes(p)) {
        await iam.send(new DetachRolePolicyCommand({ RoleName: spec.name, PolicyArn: p }));
      }
    }
  }
  return { arn, name: spec.name, created };
}

export async function deleteRole(ctx: EngineContext, name: string): Promise<boolean> {
  const iam = ctx.clients.iam;
  const existing = await ignoreNotFound(iam.send(new GetRoleCommand({ RoleName: name })));
  if (!existing?.Role) return false;
  const inline = await iam.send(new ListRolePoliciesCommand({ RoleName: name }));
  for (const p of inline.PolicyNames ?? []) {
    await ignoreNotFound(iam.send(new DeleteRolePolicyCommand({ RoleName: name, PolicyName: p })));
  }
  const attached = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name }));
  for (const p of attached.AttachedPolicies ?? []) {
    await ignoreNotFound(iam.send(new DetachRolePolicyCommand({ RoleName: name, PolicyArn: p.PolicyArn })));
  }
  await ignoreNotFound(iam.send(new DeleteRoleCommand({ RoleName: name })));
  ctx.log('info', 'deleted role', `role ${name}`);
  return true;
}
