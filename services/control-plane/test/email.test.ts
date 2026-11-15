import type { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { SESv2Client } from '@aws-sdk/client-sesv2';
import type { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { TestClock } from 'effect/testing';
import { expect } from 'vitest';
import {
  AppEmail,
  EMAIL_METRICS,
  emailQueries,
  MANUAL_PAUSE_CAUSE,
  stageEmail,
  toEmailSending,
  toSuppressedAddress,
} from '../src/email.ts';
import { awsLayer, runtime, settingsLayer } from './support.ts';

const hour = 3_600_000;
const t0 = Date.parse('2026-11-15T10:00:00Z');
const withEmail = { ...runtime, email: { domain: 'mail.platform.example.com', identityArn: 'arn:identity' } };
const tenantArn = 'arn:aws:ses:us-east-1:000000000000:tenant/shop--prod/tn-1';
const at = (h: number) => new Date(t0 + h * hour);

/** An AWS SDK error as the clients throw it. */
const awsError = (name: string, message = name) => Object.assign(new Error(message), { name });

type Command = { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> };

/** A client whose `send` answers by command (`GetTenantCommand` → `getTenant`) and records what it was sent. */
function fakeClient<C>(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const sent: Array<{ readonly command: string; readonly input: Record<string, unknown> }> = [];
  const client = {
    send: async (command: Command) => {
      const name = command.constructor.name.replace(/Command$/, '').replace(/^./, (c) => c.toLowerCase());
      sent.push({ command: name, input: command.input });
      const answer = answers[name];
      if (!answer) throw new Error(`the test has no answer for ${name}`);
      return answer(command.input);
    },
  } as unknown as C;
  return { client, sent };
}

const enabledTenant = {
  getTenant: () => ({ Tenant: { TenantName: 'shop--prod', TenantId: 'tn-1', TenantArn: tenantArn } }),
  getReputationEntity: () => ({ ReputationEntity: { SendingStatusAggregate: 'ENABLED' } }),
};

const service = (clients: Parameters<typeof awsLayer>[0], rt: typeof runtime = withEmail) =>
  AppEmail.layer.pipe(Layer.provide([awsLayer(clients), settingsLayer({ runtime: Effect.succeed(rt) })]));

describe('email facts', () => {
  it('derives the sender, tenant and limit from the live manifest', () => {
    expect(stageEmail('shop', 'prod', { name: 'Shop', dailyLimit: 500 }, withEmail.email)).toEqual({
      from: '"Shop" <shop@mail.platform.example.com>',
      tenant: 'shop--prod',
      dailyLimit: 500,
    });
    // Previews send from their own address, at most 50 recipients a day.
    expect(stageEmail('shop', 'pr-3', { dailyLimit: 500 }, withEmail.email)).toEqual({
      from: 'shop--pr-3@mail.platform.example.com',
      tenant: 'shop--pr-3',
      dailyLimit: 50,
    });
    expect(stageEmail('shop', 'prod', undefined, withEmail.email)).toBeUndefined();
    // A platform that predates email has no domain to send from.
    expect(stageEmail('shop', 'prod', { dailyLimit: 200 }, undefined)).toBeUndefined();
  });

  it('tells who paused sending', () => {
    const since = new Date('2026-11-15T09:00:00Z');
    expect(toEmailSending(undefined)).toEqual({ status: 'enabled' });
    // A tenant nobody has paused has neither status record.
    expect(toEmailSending({ SendingStatusAggregate: 'ENABLED' })).toEqual({ status: 'enabled' });
    expect(
      toEmailSending({
        SendingStatusAggregate: 'DISABLED',
        CustomerManagedStatus: {
          Status: 'DISABLED',
          Cause: 'High bounce rate finding',
          LastUpdatedTimestamp: since,
        },
      }),
    ).toEqual({
      status: 'paused',
      pausedBy: 'policy',
      cause: 'High bounce rate finding',
      since: since.toISOString(),
    });
    expect(
      toEmailSending({
        CustomerManagedStatus: { Status: 'DISABLED', Cause: MANUAL_PAUSE_CAUSE, LastUpdatedTimestamp: since },
      }),
    ).toEqual({
      status: 'paused',
      pausedBy: 'manual',
      cause: MANUAL_PAUSE_CAUSE,
      since: since.toISOString(),
    });
    // AWS's pause holds whatever the customer-managed status says.
    expect(
      toEmailSending({
        CustomerManagedStatus: { Status: 'REINSTATED', Cause: MANUAL_PAUSE_CAUSE },
        AwsSesManagedStatus: { Status: 'DISABLED', Cause: 'Under review', LastUpdatedTimestamp: since },
      }),
    ).toEqual({ status: 'paused', pausedBy: 'aws', cause: 'Under review', since: since.toISOString() });
    expect(
      toEmailSending({
        SendingStatusAggregate: 'REINSTATED',
        CustomerManagedStatus: { Status: 'REINSTATED', Cause: MANUAL_PAUSE_CAUSE },
      }),
    ).toEqual({ status: 'enabled' });
    expect(toEmailSending({ CustomerManagedStatus: { Status: 'DISABLED' } })).toEqual({
      status: 'paused',
      pausedBy: 'policy',
    });
  });

  it('queries the tenant’s SES metrics with both of their dimensions', () => {
    const queries = emailQueries({ name: 'shop--prod', id: 'tn-1' }, { from: t0, to: t0 + hour, res: '1h' });
    expect(queries.map((q) => q.MetricStat?.Metric?.MetricName)).toEqual(EMAIL_METRICS.map(([, m]) => m));
    expect(queries[3]).toEqual({
      Id: 'm3',
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SES',
          MetricName: 'Complaint',
          Dimensions: [
            { Name: 'TenantId', Value: 'tn-1' },
            { Name: 'TenantName', Value: 'shop--prod' },
          ],
        },
        Period: 3600,
        Stat: 'Sum',
      },
    });
  });

  it('maps suppression reasons', () => {
    const since = new Date('2026-11-14T00:00:00Z');
    expect(
      toSuppressedAddress({ EmailAddress: 'a@x.com', Reason: 'COMPLAINT', LastUpdateTime: since }),
    ).toEqual({ address: 'a@x.com', reason: 'complaint', since: since.toISOString() });
    expect(
      toSuppressedAddress({ EmailAddress: 'b@x.com', Reason: 'BOUNCE', LastUpdateTime: since }).reason,
    ).toBe('bounce');
  });
});

describe('email stats', () => {
  it.effect('reads status, today’s usage and the tenant’s counts', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0 + 2 * hour);
      const ses = fakeClient<SESv2Client>({
        ...enabledTenant,
        getReputationEntity: () => ({
          ReputationEntity: {
            SendingStatusAggregate: 'DISABLED',
            CustomerManagedStatus: {
              Status: 'DISABLED',
              Cause: 'Bounce finding',
              LastUpdatedTimestamp: at(1),
            },
          },
        }),
      });
      const metrics: GetMetricDataCommand[] = [];
      const cloudwatch = {
        send: async (command: GetMetricDataCommand) => {
          metrics.push(command);
          return {
            MetricDataResults: [
              { Id: 'm0', Timestamps: [at(0), at(1)], Values: [10, 4] },
              { Id: 'm1', Timestamps: [at(0), at(1)], Values: [9, 3] },
              { Id: 'm2', Timestamps: [at(1)], Values: [1] },
            ],
          };
        },
      } as unknown as CloudWatchClient;
      const reads: GetCommand[] = [];
      const ddb = {
        send: async (command: GetCommand) => {
          reads.push(command);
          return { Item: { n: 12 } };
        },
      } as unknown as DynamoDBDocumentClient;

      const stats = yield* AppEmail.use((e) =>
        e.stats(
          'shop',
          'prod',
          { name: 'Shop', dailyLimit: 300 },
          { from: t0, to: t0 + 2 * hour, res: '1h' },
        ),
      ).pipe(
        Effect.provide(service({ sesv2: () => ses.client, cloudwatch: () => cloudwatch, ddb: () => ddb })),
      );

      assert.deepStrictEqual(stats, {
        app: 'shop',
        stage: 'prod',
        enabled: true,
        from: '"Shop" <shop@mail.platform.example.com>',
        today: { sent: 12, limit: 300 },
        res: '1h',
        sending: {
          status: 'paused',
          pausedBy: 'policy',
          cause: 'Bounce finding',
          since: at(1).toISOString(),
        },
        points: [
          { ts: at(0).toISOString(), sends: 10, deliveries: 9, bounces: 0, complaints: 0 },
          { ts: at(1).toISOString(), sends: 4, deliveries: 3, bounces: 1, complaints: 0 },
          { ts: at(2).toISOString(), sends: 0, deliveries: 0, bounces: 0, complaints: 0 },
        ],
        totals: { sends: 14, deliveries: 12, bounces: 1, complaints: 0 },
      });
      assert.deepStrictEqual(ses.sent, [
        { command: 'getTenant', input: { TenantName: 'shop--prod' } },
        {
          command: 'getReputationEntity',
          input: { ReputationEntityType: 'RESOURCE', ReputationEntityReference: tenantArn },
        },
      ]);
      assert.deepStrictEqual(reads[0]?.input.Key, { pk: 'mail#shop#prod', sk: '2026-11-15' });
      assert.strictEqual(reads[0]?.input.TableName, 'platform-telemetry');
      assert.deepStrictEqual(metrics[0]?.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.Dimensions, [
        { Name: 'TenantId', Value: 'tn-1' },
        { Name: 'TenantName', Value: 'shop--prod' },
      ]);
    }),
  );

  it.effect('reports email off without calling SES, and a missing tenant as nothing sent', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(t0 + hour);
      const range = { from: t0, to: t0 + hour, res: '1h' as const };
      const ses = fakeClient<SESv2Client>({
        getTenant: () => {
          throw awsError('NotFoundException', 'The requested tenant <shop--pr-2> does not exist.');
        },
      });
      const ddb = { send: async () => ({}) } as unknown as DynamoDBDocumentClient;
      const stats = (
        email: { dailyLimit: number } | undefined,
        stage = 'prod',
        rt: typeof runtime = withEmail,
      ) =>
        AppEmail.use((e) => e.stats('shop', stage, email, range)).pipe(
          Effect.provide(service({ sesv2: () => ses.client, ddb: () => ddb }, rt)),
        );

      const off = yield* stats(undefined);
      assert.strictEqual(off.enabled, false);
      assert.strictEqual(off.from, undefined);
      assert.strictEqual(off.points.length, 2);
      assert.deepStrictEqual(off.totals, { sends: 0, deliveries: 0, bounces: 0, complaints: 0 });
      // A platform without a mail domain can't have sent any.
      assert.strictEqual((yield* stats({ dailyLimit: 200 }, 'prod', runtime)).enabled, false);
      assert.strictEqual(ses.sent.length, 0);

      const pending = yield* stats({ dailyLimit: 200 }, 'pr-2');
      assert.strictEqual(pending.enabled, true);
      assert.strictEqual(pending.from, 'shop--pr-2@mail.platform.example.com');
      assert.deepStrictEqual(pending.today, { sent: 0, limit: 50 });
      assert.strictEqual(pending.sending, undefined);
      assert.strictEqual(pending.totals.sends, 0);
    }),
  );

  it.effect('answers whether a tenant can send, or none without one', () =>
    Effect.gen(function* () {
      const ses = fakeClient<SESv2Client>(enabledTenant);
      const missing = fakeClient<SESv2Client>({
        getTenant: () => {
          throw awsError('NotFoundException');
        },
      });
      const sending = (client: SESv2Client) =>
        AppEmail.use((e) => e.sending('shop', 'prod')).pipe(Effect.provide(service({ sesv2: () => client })));
      assert.deepStrictEqual(yield* sending(ses.client), Option.some({ status: 'enabled' as const }));
      assert.deepStrictEqual(yield* sending(missing.client), Option.none());
      const throttled = fakeClient<SESv2Client>({
        getTenant: () => {
          throw awsError('TooManyRequestsException');
        },
      });
      const failed = yield* Effect.flip(sending(throttled.client));
      assert.strictEqual(failed.code, 'TooManyRequestsException');
    }),
  );
});

describe('suppression list', () => {
  it.effect('pages through the tenant’s list', () =>
    Effect.gen(function* () {
      const since = new Date('2026-11-14T00:00:00Z');
      const ses = fakeClient<SESv2Client>({
        listSuppressedDestinations: (input) => {
          if (input.NextToken === 'bad') throw awsError('InvalidNextTokenException', 'Token is invalid.');
          if (input.TenantName === 'shop--pr-9') throw awsError('NotFoundException');
          return input.NextToken
            ? {
                SuppressedDestinationSummaries: [
                  { EmailAddress: 'c@x.com', Reason: 'BOUNCE', LastUpdateTime: since },
                ],
              }
            : {
                SuppressedDestinationSummaries: [
                  { EmailAddress: 'a@x.com', Reason: 'BOUNCE', LastUpdateTime: since },
                  { EmailAddress: 'b@x.com', Reason: 'COMPLAINT', LastUpdateTime: since },
                ],
                NextToken: 'page-2',
              };
        },
      });
      const page = (next?: string, stage = 'prod') =>
        AppEmail.use((e) => e.suppressed('shop', stage, next)).pipe(
          Effect.provide(service({ sesv2: () => ses.client })),
        );

      const first = yield* page();
      assert.deepStrictEqual(first, {
        items: [
          { address: 'a@x.com', reason: 'bounce', since: since.toISOString() },
          { address: 'b@x.com', reason: 'complaint', since: since.toISOString() },
        ],
        next: 'page-2',
      });
      const second = yield* page(first.next);
      assert.deepStrictEqual(second, {
        items: [{ address: 'c@x.com', reason: 'bounce', since: since.toISOString() }],
      });
      assert.deepStrictEqual(
        ses.sent.map((s) => s.input),
        [
          { TenantName: 'shop--prod', PageSize: 100 },
          { TenantName: 'shop--prod', PageSize: 100, NextToken: 'page-2' },
        ],
      );

      const bad = yield* Effect.flip(page('bad'));
      assert.strictEqual(bad._tag, 'BadRequest');
      const gone = yield* Effect.flip(page(undefined, 'pr-9'));
      assert.deepStrictEqual([gone._tag, gone.message], ['NotFound', 'email tenant shop--pr-9 not found']);
    }),
  );

  it.effect('removes an address from the tenant’s list, and says when it isn’t on it', () =>
    Effect.gen(function* () {
      const ses = fakeClient<SESv2Client>({
        deleteSuppressedDestination: (input) => {
          if (input.EmailAddress === 'nobody@x.com') throw awsError('NotFoundException');
          return {};
        },
      });
      const unsuppress = (address: string) =>
        AppEmail.use((e) => e.unsuppress('shop', 'prod', address)).pipe(
          Effect.provide(service({ sesv2: () => ses.client })),
        );
      yield* unsuppress('a@x.com');
      assert.deepStrictEqual(ses.sent[0], {
        command: 'deleteSuppressedDestination',
        input: { EmailAddress: 'a@x.com', TenantName: 'shop--prod' },
      });
      const missing = yield* Effect.flip(unsuppress('nobody@x.com'));
      assert.strictEqual(missing.message, "nobody@x.com is not on shop/prod's suppression list");
    }),
  );
});

describe('resuming email', () => {
  /** `resume` on a tenant with this reputation entity, and the status updates it sent. */
  const resume = (reputation: Record<string, unknown>) => {
    const ses = fakeClient<SESv2Client>({
      ...enabledTenant,
      getReputationEntity: () => ({ ReputationEntity: reputation }),
      updateReputationEntityCustomerManagedStatus: () => ({}),
    });
    const updates = () => ses.sent.filter((s) => s.command === 'updateReputationEntityCustomerManagedStatus');
    const run = AppEmail.use((e) => e.resume('shop', 'prod')).pipe(
      Effect.provide(service({ sesv2: () => ses.client })),
    );
    return { run, updates };
  };

  it.effect('reinstates a pause by the policy or by hand', () =>
    Effect.gen(function* () {
      for (const Cause of ['Bounce finding', MANUAL_PAUSE_CAUSE]) {
        const { run, updates } = resume({ CustomerManagedStatus: { Status: 'DISABLED', Cause } });
        assert.deepStrictEqual(yield* run, { status: 'enabled' });
        assert.deepStrictEqual(
          updates().map((u) => u.input),
          [
            {
              ReputationEntityType: 'RESOURCE',
              ReputationEntityReference: tenantArn,
              SendingStatus: 'REINSTATED',
            },
          ],
        );
      }
    }),
  );

  it.effect('refuses a pause by AWS, and leaves a sending stage alone', () =>
    Effect.gen(function* () {
      const byAws = resume({
        CustomerManagedStatus: { Status: 'DISABLED', Cause: 'Bounce finding' },
        AwsSesManagedStatus: { Status: 'DISABLED', Cause: 'Under review' },
      });
      const refused = yield* Effect.flip(byAws.run);
      assert.strictEqual(refused._tag, 'Conflict');
      assert.strictEqual(refused.code, 'paused_by_aws');
      assert.match(refused.message, /^AWS paused sending for shop\/prod \(Under review\); only AWS Support/);
      assert.strictEqual(byAws.updates().length, 0);

      const sending = resume({ SendingStatusAggregate: 'ENABLED' });
      assert.deepStrictEqual(yield* sending.run, { status: 'enabled' });
      assert.strictEqual(sending.updates().length, 0);
    }),
  );
});
