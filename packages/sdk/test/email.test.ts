import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type CapturedEmail,
  type EmailBindings,
  type EmailMessage,
  LOCAL_MAIL_URL_ENV,
  type TelemetryEvent,
} from '@ericminassian/platform-core';
import { Cause, Effect, Exit, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Email, EmailNotSent, Platform } from '../src/index.ts';
import { newContext, runWithContext } from '../src/runtime/context.ts';
import { EmailRefused, emailUsageUpdate, sendEmail, sesMailbox } from '../src/runtime/email.ts';
import { installFetchInstrumentation } from '../src/runtime/telemetry.ts';
import {
  captureEmails,
  captureTelemetry,
  mockClient,
  resetPlatform,
  useTestBindings,
} from '../src/testing.ts';

const TRACE = '0123456789abcdef0123456789abcdef';
const ses: EmailBindings = {
  mode: 'ses',
  from: 'todo@mail.platform.example.org',
  name: 'Todo',
  tenant: 'todo--prod',
  dailyLimit: 200,
  usageTable: 'platform-telemetry',
};
const message: EmailMessage = { to: 'alice@gmail.com', subject: 'New todo', text: 'Buy milk' };

interface Call {
  name: string;
  input: Record<string, unknown>;
}
const awsError = (name: string, msg: string) => Object.assign(new Error(msg), { name });

/** Fakes for DynamoDB and SES: records every command, answers with `ddb` / `send`. */
function fakeAws(opts: { ddb?: (c: Call) => unknown; send?: (c: Call) => unknown } = {}): {
  ddb: Call[];
  ses: Call[];
} {
  const calls = { ddb: [] as Call[], ses: [] as Call[] };
  mockClient('ddb', (cmd) => {
    const c = { name: cmd.constructor.name, input: cmd.input };
    calls.ddb.push(c);
    return opts.ddb ? opts.ddb(c) : {};
  });
  mockClient('sesv2', (cmd) => {
    const c = { name: cmd.constructor.name, input: cmd.input };
    calls.ses.push(c);
    return opts.send ? opts.send(c) : { MessageId: '0100018c-ses-id' };
  });
  return calls;
}

/** Runs `fn` inside a request context, as the server wrapper does. */
const inTrace = <T>(fn: () => Promise<T>) => runWithContext(newContext(TRACE), fn);

const refusal = async (p: Promise<unknown>): Promise<EmailRefused> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EmailRefused);
  return err as EmailRefused;
};

let tel: ReturnType<typeof captureTelemetry>;
const events = <K extends TelemetryEvent['t']>(t: K) =>
  tel.events.filter((e): e is Extract<TelemetryEvent, { t: K }> => e.t === t);

beforeEach(() => {
  tel = captureTelemetry();
  useTestBindings({ app: 'todo', stage: 'prod', email: ses });
});
afterEach(() => {
  tel.stop();
  resetPlatform();
  vi.useRealTimers();
});

describe('sendEmail: checks', () => {
  it('refuses invalid messages before counting or sending', async () => {
    const calls = fakeAws();
    const cases: Array<[EmailMessage, RegExp]> = [
      [{ ...message, to: [] }, /at least one recipient/],
      [{ ...message, to: 'not-an-address' }, /"not-an-address" is not an email address/],
      [{ ...message, replyTo: 'nope' }, /"nope" is not an email address/],
      [{ ...message, to: Array.from({ length: 51 }, (_, i) => `u${i}@gmail.com`) }, /at most 50/],
      [{ ...message, subject: '  ' }, /needs a subject/],
      [{ ...message, subject: 'two\nlines' }, /one line/],
      [{ ...message, text: '' }, /needs a `text` body/],
    ];
    for (const [m, why] of cases) {
      const err = await refusal(sendEmail(m));
      expect(err.reason).toBe('rejected');
      expect(err.message).toMatch(why);
    }
    expect(calls).toEqual({ ddb: [], ses: [] });
  });

  it('says how to enable email when the app has none', async () => {
    useTestBindings({ app: 'todo' });
    await expect(sendEmail(message)).rejects.toThrow(/Add `email` to plat\.config\.ts/);
    await expect(sendEmail(message)).rejects.not.toBeInstanceOf(EmailRefused);
  });
});

describe('sendEmail: SES', () => {
  it('counts the recipients for the UTC day, then sends through the stage’s tenant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T23:59:30Z'));
    const calls = fakeAws();
    const result = await inTrace(() =>
      sendEmail({
        to: [' alice@gmail.com', 'bob@gmail.com'],
        subject: 'Your invite',
        text: 'Join us',
        html: '<p>Join us</p>',
        replyTo: 'owner@gmail.com',
      }),
    );
    expect(result).toEqual({ id: '0100018c-ses-id' });

    expect(calls.ddb).toEqual([
      {
        name: 'UpdateCommand',
        input: {
          TableName: 'platform-telemetry',
          Key: { pk: 'mail#todo#prod', sk: '2026-11-15' },
          UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #n :k',
          ConditionExpression: 'attribute_not_exists(#n) OR #n <= :max',
          ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
          // Expires 3 days after the day ends.
          ExpressionAttributeValues: {
            ':k': 2,
            ':max': 198,
            ':ttl': Date.parse('2026-11-16T00:00:00Z') / 1000 + 3 * 24 * 3600,
          },
        },
      },
    ]);
    expect(calls.ses).toEqual([
      {
        name: 'SendEmailCommand',
        input: {
          FromEmailAddress: '"Todo" <todo@mail.platform.example.org>',
          Destination: { ToAddresses: ['alice@gmail.com', 'bob@gmail.com'] },
          ReplyToAddresses: ['owner@gmail.com'],
          Content: {
            Simple: {
              Subject: { Data: 'Your invite', Charset: 'UTF-8' },
              Body: {
                Text: { Data: 'Join us', Charset: 'UTF-8' },
                Html: { Data: '<p>Join us</p>', Charset: 'UTF-8' },
              },
            },
          },
          ConfigurationSetName: 'todo--prod',
          TenantName: 'todo--prod',
          EmailTags: [{ Name: 'trace', Value: TRACE }],
        },
      },
    ]);
  });

  it('sends a bare address without a display name, and tags only traced sends', async () => {
    useTestBindings({ app: 'todo', stage: 'prod', email: { ...ses, name: undefined } });
    const calls = fakeAws();
    await sendEmail({ ...message, text: '', html: '<b>hi</b>' });
    const input = calls.ses[0]!.input as Record<string, unknown> & { Content: { Simple: { Body: object } } };
    expect(input.FromEmailAddress).toBe('todo@mail.platform.example.org');
    expect(input.Content.Simple.Body).toEqual({ Html: { Data: '<b>hi</b>', Charset: 'UTF-8' } });
    expect(input).not.toHaveProperty('EmailTags');
    expect(input).not.toHaveProperty('ReplyToAddresses');
    // A trace id SES can't carry as a tag value is left off.
    await runWithContext(newContext('not a valid tag!'), () => sendEmail(message));
    expect(calls.ses[1]!.input).not.toHaveProperty('EmailTags');
  });

  it('encodes a non-ASCII display name as RFC 2047 encoded-words', async () => {
    useTestBindings({ app: 'todo', stage: 'prod', email: { ...ses, name: 'Tâches ✓' } });
    const calls = fakeAws();
    await sendEmail(message);
    const from = calls.ses[0]!.input.FromEmailAddress as string;
    expect(from).toBe(
      `=?UTF-8?B?${Buffer.from('Tâches ✓').toString('base64')}?= <todo@mail.platform.example.org>`,
    );
  });

  it('splits a long encoded name into words of at most 75 characters, between characters', () => {
    const name = 'Ünïcödé '.repeat(8).trim();
    const from = sesMailbox('a@mail.example.org', name);
    const words = from.slice(0, from.lastIndexOf(' <')).split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe(name);
    expect(sesMailbox('a@mail.example.org', 'Plain Name')).toBe('"Plain Name" <a@mail.example.org>');
  });

  it('skips recipients at reserved test domains, with a log line', async () => {
    const calls = fakeAws();
    await sendEmail({ ...message, to: ['alice@example.com', 'real@gmail.com', 'bob@app.test'] });
    expect(calls.ddb[0]!.input.ExpressionAttributeValues).toMatchObject({ ':k': 1 });
    expect((calls.ses[0]!.input.Destination as object) ?? {}).toEqual({ ToAddresses: ['real@gmail.com'] });
    expect(events('log')).toEqual([
      expect.objectContaining({ level: 'info', skipped: ['alice@example.com', 'bob@app.test'] }),
    ]);
  });

  it('sends nothing when every recipient is reserved, and still returns an id', async () => {
    const calls = fakeAws();
    const { id } = await sendEmail({ ...message, to: ['alice@example.com', 'carol@mail.invalid'] });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toEqual({ ddb: [], ses: [] });
  });

  it('refuses a send that would pass the daily limit, without calling SES', async () => {
    const calls = fakeAws({
      ddb: () => {
        throw awsError('ConditionalCheckFailedException', 'The conditional request failed');
      },
    });
    const err = await refusal(sendEmail(message));
    expect(err.reason).toBe('daily-limit');
    expect(err.message).toMatch(/daily limit of 200/);
    expect(err.message).toMatch(/email\.dailyLimit in plat\.config\.ts/);
    expect(calls.ses).toEqual([]);
  });

  it('refuses a message with more recipients than the whole limit without counting it', async () => {
    useTestBindings({ app: 'todo', stage: 'pr-3', email: { ...ses, tenant: 'todo--pr-3', dailyLimit: 2 } });
    const calls = fakeAws();
    const err = await refusal(sendEmail({ ...message, to: ['a@gmail.com', 'b@gmail.com', 'c@gmail.com'] }));
    expect(err.reason).toBe('daily-limit');
    expect(err.message).toMatch(/3 more recipients would pass this stage's daily limit of 2/);
    expect(calls).toEqual({ ddb: [], ses: [] });
  });

  it('maps a paused stage, a refused message and other failures, giving the count back each time', async () => {
    const cases: Array<[Error, 'paused' | 'rejected' | undefined]> = [
      [
        awsError(
          'MessageRejected',
          'Sending disabled for <arn:aws:ses:us-east-1:000000000000:tenant/todo--prod/tn-1>. For more information, please check the resource configuration and status.',
        ),
        'paused',
      ],
      [awsError('SendingPausedException', 'Sending is paused for this account'), 'paused'],
      [awsError('AccountSuspendedException', 'Account suspended'), 'paused'],
      [awsError('MessageRejected', 'Email address is not verified.'), 'rejected'],
      [awsError('BadRequestException', 'Illegal address'), 'rejected'],
      [awsError('MailFromDomainNotVerifiedException', 'MAIL FROM not verified'), 'rejected'],
      [awsError('TooManyRequestsException', 'Maximum sending rate exceeded'), undefined],
      [awsError('AccessDeniedException', 'not authorized'), undefined],
    ];
    for (const [error, reason] of cases) {
      const calls = fakeAws({
        send: () => {
          throw error;
        },
      });
      const err = await sendEmail(message).then(
        () => undefined,
        (e: unknown) => e,
      );
      // A refusal's reason, or `defect` when the error comes out unchanged.
      const outcome = err instanceof EmailRefused ? err.reason : err === error ? 'defect' : err;
      expect(outcome, error.name).toBe(reason ?? 'defect');
      expect(calls.ddb.map((c) => c.input.ExpressionAttributeValues)).toEqual([
        expect.objectContaining({ ':k': 1 }),
        { ':k': -1 },
      ]);
      expect(calls.ddb[1]!.input).toMatchObject({
        Key: { pk: 'mail#todo#prod' },
        UpdateExpression: 'ADD #n :k',
        ExpressionAttributeNames: { '#n': 'n' },
      });
    }
  });

  it('points a paused stage at the console and `plat email`, without SES’s ARN', async () => {
    fakeAws({
      send: () => {
        throw awsError(
          'MessageRejected',
          'Sending disabled for <arn:aws:ses:us-east-1:000000000000:tenant/x/tn-1>.',
        );
      },
    });
    const err = await refusal(sendEmail(message));
    expect(err.message).toMatch(/sending is paused for todo--prod/);
    expect(err.message).toMatch(
      /`plat email` \(or the app's Email page in the console\) shows why; `plat email resume` resumes it/,
    );
    expect(err.message).not.toMatch(/arn:/);
  });

  it('keeps the send’s failure when giving the count back fails too', async () => {
    let n = 0;
    fakeAws({
      ddb: () => {
        if (n++ > 0) throw awsError('ProvisionedThroughputExceededException', 'slow down');
        return {};
      },
      send: () => {
        throw awsError('MessageRejected', 'Email address is not verified.');
      },
    });
    const err = await refusal(sendEmail(message));
    expect(err.reason).toBe('rejected');
    expect(events('log')).toEqual([expect.objectContaining({ level: 'warn', error: 'slow down' })]);
  });

  it('records one email.send span named by the tenant', async () => {
    fakeAws();
    await inTrace(() => sendEmail({ ...message, to: ['a@gmail.com', 'b@gmail.com'] }));
    fakeAws({
      ddb: () => {
        throw awsError('ConditionalCheckFailedException', 'failed');
      },
    });
    await inTrace(() => sendEmail(message)).catch(() => undefined);
    expect(events('span')).toEqual([
      expect.objectContaining({ op: 'email.send', name: 'todo--prod', status: 'ok', trace: TRACE }),
      expect.objectContaining({ op: 'email.send', name: 'todo--prod', status: 'error', trace: TRACE }),
    ]);
  });
});

describe('sendEmail: local', () => {
  const local: EmailBindings = {
    ...ses,
    mode: 'local',
    from: 'todo--local@mail.localhost',
    tenant: 'todo--local',
    dailyLimit: 50,
  };
  let inbox: Server;
  let received: Array<{ contentType?: string; body: CapturedEmail }>;
  let status = 201;
  const savedUrl = process.env[LOCAL_MAIL_URL_ENV];

  beforeAll(async () => {
    inbox = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ contentType: req.headers['content-type'], body: JSON.parse(body) as CapturedEmail });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => inbox.listen(0, '127.0.0.1', r));
  });
  afterAll(() => {
    inbox.close();
    if (savedUrl === undefined) delete process.env[LOCAL_MAIL_URL_ENV];
    else process.env[LOCAL_MAIL_URL_ENV] = savedUrl;
  });
  beforeEach(() => {
    received = [];
    status = 201;
    process.env[LOCAL_MAIL_URL_ENV] =
      `http://127.0.0.1:${(inbox.address() as AddressInfo).port}/__platform/mail/messages`;
    useTestBindings({ app: 'todo', stage: 'local', email: local });
  });

  it('counts like a deployed stage, then posts the message to the local inbox instead of SES', async () => {
    const calls = fakeAws();
    installFetchInstrumentation();
    const { id } = await inTrace(() =>
      sendEmail({ to: 'alice@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' }),
    );
    expect(calls.ses).toEqual([]);
    expect(calls.ddb[0]!.input).toMatchObject({
      Key: { pk: 'mail#todo#local' },
      ExpressionAttributeValues: { ':k': 1, ':max': 49 },
    });
    expect(received).toEqual([
      {
        contentType: 'application/json',
        body: {
          id,
          at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
          app: 'todo',
          stage: 'local',
          from: '"Todo" <todo--local@mail.localhost>',
          // Reserved domains reach the local inbox: nothing is really sent.
          to: ['alice@example.com'],
          replyTo: [],
          subject: 'Hi',
          text: 'Hello',
          html: '<p>Hello</p>',
        },
      },
    ]);
    // The post is the email.send span itself, not an outgoing fetch.
    expect(events('span').map((s) => s.op)).toEqual(['email.send']);
  });

  it('refuses at the daily limit locally too', async () => {
    fakeAws({
      ddb: () => {
        throw awsError('ConditionalCheckFailedException', 'failed');
      },
    });
    expect((await refusal(sendEmail(message))).reason).toBe('daily-limit');
    expect(received).toEqual([]);
  });

  it('gives the count back when the inbox refuses the message', async () => {
    const calls = fakeAws();
    status = 500;
    await expect(sendEmail(message)).rejects.toThrow(
      /local inbox at http:\/\/127\.0\.0\.1:\d+\S* answered 500/,
    );
    expect(calls.ddb.map((c) => (c.input.ExpressionAttributeValues as { ':k': number })[':k'])).toEqual([
      1, -1,
    ]);
  });

  it('needs the inbox URL from plat dev or plat test', async () => {
    const calls = fakeAws();
    delete process.env[LOCAL_MAIL_URL_ENV];
    await expect(sendEmail(message)).rejects.toThrow(/PLATFORM_LOCAL_MAIL_URL is not set.*captureEmails\(\)/);
    expect(calls).toEqual({ ddb: [], ses: [] });
  });
});

describe('captureEmails', () => {
  it('records messages without counting or delivering them, still checking them', async () => {
    const calls = fakeAws();
    const captured = captureEmails();
    const { id } = await sendEmail({
      to: 'alice@example.com',
      subject: 'Hi',
      text: 'Hello',
      replyTo: ['x@y.org'],
    });
    expect((await refusal(sendEmail({ ...message, to: 'bad' }))).reason).toBe('rejected');
    expect(captured.sent).toEqual([
      {
        id,
        at: expect.any(String) as unknown,
        app: 'todo',
        stage: 'prod',
        from: '"Todo" <todo@mail.platform.example.org>',
        to: ['alice@example.com'],
        replyTo: ['x@y.org'],
        subject: 'Hi',
        text: 'Hello',
      },
    ]);
    expect(calls).toEqual({ ddb: [], ses: [] });
    captured.stop();
    await sendEmail(message);
    expect(calls.ses).toHaveLength(1);
  });
});

describe('emailUsageUpdate', () => {
  it('lets a send through while the day stays within the limit', () => {
    const u = emailUsageUpdate({
      table: 't',
      app: 'a',
      stage: 'prod',
      day: '2026-01-31',
      recipients: 5,
      limit: 5,
    });
    expect(u.ExpressionAttributeValues).toEqual({
      ':k': 5,
      ':max': 0,
      ':ttl': Date.parse('2026-02-01T00:00:00Z') / 1000 + 3 * 24 * 3600,
    });
  });
});

describe('Email (Effect)', () => {
  const run = <A, E>(effect: Effect.Effect<A, E, Email>) =>
    Effect.runPromiseExit(effect.pipe(Effect.provide(Email.layer)));
  const sendIt = (m: EmailMessage) =>
    Effect.gen(function* () {
      return yield* (yield* Email).send(m);
    });

  it('fails with EmailNotSent for what the app can handle, and dies on anything else', async () => {
    fakeAws({
      ddb: () => {
        throw awsError('ConditionalCheckFailedException', 'failed');
      },
    });
    const limited = await run(sendIt(message));
    expect(Exit.isFailure(limited) && Cause.findErrorOption(limited.cause)).toMatchObject({
      value: { _tag: 'EmailNotSent', reason: 'daily-limit' },
    });
    const caught = await run(
      sendIt(message).pipe(Effect.catchTag('EmailNotSent', (e) => Effect.succeed(e.reason))),
    );
    expect(caught).toEqual(Exit.succeed('daily-limit'));

    fakeAws({
      send: () => {
        throw awsError('InternalFailure', 'boom');
      },
    });
    const broken = await run(sendIt(message));
    expect(Exit.isFailure(broken) && Cause.hasDies(broken.cause)).toBe(true);
    expect(String(broken)).toMatch(/boom/);
  });

  it('sends with Platform.layer and returns the message id', async () => {
    fakeAws();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(Platform.layer)),
    );
    expect(exit).toEqual(Exit.succeed({ id: '0100018c-ses-id' }));
  });
});

describe('Email in memory', () => {
  const send = (m: EmailMessage) =>
    Effect.gen(function* () {
      return yield* (yield* Email).send(m);
    });
  const reason = (effect: Effect.Effect<unknown, EmailNotSent, Email>) =>
    effect.pipe(
      Effect.flip,
      Effect.map((e) => e.reason),
    );

  it('records what was sent, normalized', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { id } = yield* send({
          to: ' alice@example.com',
          subject: 'Hi',
          text: 'Hello',
          html: '<p>Hi</p>',
        });
        yield* send({
          to: ['a@example.com', 'b@example.com'],
          subject: 'Two',
          text: 'x',
          replyTo: 'r@example.com',
        });
        expect(yield* reason(send({ ...message, subject: '' }))).toBe('rejected');
        expect(yield* (yield* Platform.Memory).emails).toEqual([
          { id, to: ['alice@example.com'], replyTo: [], subject: 'Hi', text: 'Hello', html: '<p>Hi</p>' },
          {
            id: expect.any(String) as unknown,
            to: ['a@example.com', 'b@example.com'],
            replyTo: ['r@example.com'],
            subject: 'Two',
            text: 'x',
          },
        ]);
      }).pipe(Effect.provide(Platform.layerMemory())),
    ));

  it('enforces a daily limit per UTC day of the effect Clock', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* send({ ...message, to: ['a@example.com', 'b@example.com'] });
        const refused = yield* Effect.flip(send({ ...message, to: ['c@example.com', 'd@example.com'] }));
        expect(refused).toBeInstanceOf(EmailNotSent);
        expect(refused).toMatchObject({
          reason: 'daily-limit',
          message: expect.stringMatching(/daily limit of 3/) as unknown,
        });
        yield* send(message);
        expect(yield* reason(send(message))).toBe('daily-limit');
        yield* TestClock.adjust('1 day');
        yield* send({ ...message, to: ['a@example.com', 'b@example.com', 'c@example.com'] });
        expect((yield* (yield* Platform.Memory).emails).length).toBe(3);
      }).pipe(
        Effect.provide(Layer.merge(Platform.layerMemory({ email: { dailyLimit: 3 } }), TestClock.layer())),
      ),
    ));

  it('refuses every send while paused', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const refused = yield* Effect.flip(send(message));
        expect(refused).toMatchObject({
          reason: 'paused',
          message: expect.stringMatching(/paused for shop--pr-4\. `plat email --stage pr-4`/) as unknown,
        });
        expect(yield* (yield* Platform.Memory).emails).toEqual([]);
      }).pipe(
        Effect.provide(
          Platform.layerMemory({ email: { paused: true }, app: { name: 'shop', stage: 'pr-4' } }),
        ),
      ),
    ));
});
