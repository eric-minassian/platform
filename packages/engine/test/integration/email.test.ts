import { GetRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  GetConfigurationSetCommand,
  GetEmailIdentityCommand,
  GetTenantCommand,
  ListTenantResourcesCommand,
} from '@aws-sdk/client-sesv2';
import {
  names,
  newDeploymentId,
  type PlatformRuntimeConfig,
  parseManifest,
  TAGS,
} from '@ericminassian/platform-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEngine,
  type EmulatorConnection,
  type Engine,
  engineContext,
  ensureLocalPlatform,
  findEmulatorBinary,
  startEmulator,
} from '../../src/index.ts';

const app = 'etest';
const stage = 'em1';
const tenantName = names.emailTenant(app, stage);
const web = { server: 'src/server.ts' };
const withEmail = parseManifest({ name: app, web, email: { name: 'Email Test', dailyLimit: 500 } });
const withoutEmail = parseManifest({ name: app, web });

describe.skipIf(!findEmulatorBinary() && !process.env.PLAT_EMULATOR_ENDPOINT)(
  'email stages on the AWS Emulator',
  () => {
    let conn: EmulatorConnection;
    let engine: Engine;
    let platform: PlatformRuntimeConfig;

    beforeAll(async () => {
      conn = await startEmulator({ idleTimeoutSeconds: 600 });
      engine = createEngine({
        region: conn.region,
        emulator: { endpoint: conn.endpoint, caFile: conn.caFile, credentials: conn.credentials },
      });
      platform = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
    });

    afterAll(async () => {
      await conn?.stop();
    });

    const ses = () => engineContext(engine).clients.ses;
    const deploy = (manifest = withEmail) =>
      engine.deployStage({
        manifest,
        stage,
        deploymentId: newDeploymentId(),
        platform,
        artifacts: {},
        webMode: 'external',
      });
    const tenant = () =>
      ses()
        .send(new GetTenantCommand({ TenantName: tenantName }))
        .then((r) => r.Tenant);
    const associated = () =>
      ses()
        .send(new ListTenantResourcesCommand({ TenantName: tenantName }))
        .then((r) => (r.TenantResources ?? []).flatMap((x) => x.ResourceArn ?? []).toSorted());
    const configurationSet = () =>
      ses().send(new GetConfigurationSetCommand({ ConfigurationSetName: tenantName }));
    const rolePolicy = () =>
      engineContext(engine)
        .clients.iam.send(
          new GetRolePolicyCommand({ RoleName: names.role(app, stage), PolicyName: 'runtime' }),
        )
        .then((r) => decodeURIComponent(r.PolicyDocument!));
    const configurationSetArn = () =>
      `arn:aws:ses:${conn.region}:000000000000:configuration-set/${tenantName}`;

    it('creates the mail domain once', async () => {
      expect(platform.email).toEqual({
        domain: 'mail.localhost',
        identityArn: `arn:aws:ses:${conn.region}:000000000000:identity/mail.localhost`,
      });
      const identity = await ses().send(new GetEmailIdentityCommand({ EmailIdentity: 'mail.localhost' }));
      expect(identity.IdentityType).toBe('DOMAIN');
      const again = await ensureLocalPlatform(engine, { port: 3000, jwksBaseUrl: conn.endpoint });
      expect(again.email).toEqual(platform.email);
    });

    it('gives a stage a tenant on its own suppression list, tied to the domain and its configuration set', async () => {
      const result = await deploy();
      expect(result.bindings.email).toEqual({
        mode: 'local',
        from: 'etest--em1@mail.localhost',
        name: 'Email Test',
        tenant: tenantName,
        // Declared 500, but only prod gets more than 50.
        dailyLimit: 50,
        usageTable: platform.telemetryTable,
      });

      const t = await tenant();
      expect(t?.SuppressionAttributes?.SuppressionScope).toBe('TENANT');
      expect((t?.SuppressionAttributes?.SuppressedReasons ?? []).toSorted()).toEqual(['BOUNCE', 'COMPLAINT']);
      expect(t?.Tags).toContainEqual({ Key: TAGS.app, Value: app });
      expect(await associated()).toEqual([configurationSetArn(), platform.email!.identityArn].toSorted());
      const cs = await configurationSet();
      expect(cs.ReputationOptions?.ReputationMetricsEnabled).toBe(true);
      expect(cs.Tags).toContainEqual({ Key: TAGS.stage, Value: stage });

      const policy = await rolePolicy();
      expect(policy).toContain('ses:SendEmail');
      expect(policy).toContain(`"ses:TenantName":"${tenantName}"`);
      expect(policy).toContain(`"dynamodb:LeadingKeys":["mail#${app}#${stage}"]`);

      const listed = (await engine.listStageResources(app, stage)).map((r) => `${r.type}:${r.name}`);
      expect(listed).toEqual(
        expect.arrayContaining([`email-tenant:${tenantName}`, `configuration-set:${tenantName}`]),
      );
    });

    it('redeploys onto the same tenant', async () => {
      const before = await tenant();
      await deploy();
      expect((await tenant())?.TenantId).toBe(before?.TenantId);
      expect(await associated()).toHaveLength(2);
    });

    it('keeps the tenant and configuration set when email leaves the config, but not the grant', async () => {
      const id = (await tenant())?.TenantId;
      const result = await deploy(withoutEmail);
      expect(result.bindings.email).toBeUndefined();
      expect((await tenant())?.TenantId).toBe(id);
      expect(await associated()).toHaveLength(2);
      expect((await configurationSet()).ConfigurationSetName).toBe(tenantName);
      const policy = await rolePolicy();
      expect(policy).not.toContain('ses:');
      expect(policy).not.toContain('mail#');
    });

    it('deletes both with the stage', async () => {
      await deploy();
      await engine.destroyStage({ app, stage, platform });
      expect(await tenant().catch((e: Error) => e.name)).toBe('NotFoundException');
      expect(await configurationSet().catch((e: Error) => e.name)).toBe('NotFoundException');
      expect(await engine.listStageResources(app, stage)).toEqual([]);
    });
  },
);
