import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  APP_CONFIG_FILE,
  type Bindings,
  type CapturedEmail,
  checkEmailMessage,
  EMAIL_NON_PROD_DAILY_LIMIT,
  EMAIL_USAGE_TTL_SECONDS,
  type EmailBindings,
  type EmailMessage,
  type EmailNotSentReason,
  emailUsageDay,
  formatMailbox,
  isReservedEmailDomain,
  LOCAL_MAIL_URL_ENV,
  PROD_STAGE,
  telemetryKeys,
} from '@ericminassian/platform-core';
import { getBindings } from './bindings.ts';
import { client, ddbClient } from './clients.ts';
import { currentContext } from './context.ts';
import { log, span, uninstrumentedFetch } from './telemetry.ts';

/**
 * Transactional email on SES (see core `email.ts`). Deployed stages count
 * recipients against the daily limit, then send through the stage's SES
 * tenant. Under `plat dev` / `plat test` (`mode: 'local'`) the count runs the
 * same way in the emulator and the message goes to the CLI's inbox instead.
 */

/** Why `sendEmail` refused a message; the `Email` service turns it into `EmailNotSent`. */
export class EmailRefused extends Error {
  override readonly name = 'EmailNotSent';
  readonly reason: EmailNotSentReason;
  constructor(reason: EmailNotSentReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Messages shared with the in-memory `Email`, so tests see what the deployed app reports. */
export const emailRefusals = {
  dailyLimit: (limit: number, recipients: number): string =>
    `email.send: ${recipients === 1 ? '1 more recipient' : `${recipients} more recipients`} would pass this stage's daily limit of ${limit}. Raise email.dailyLimit in ${APP_CONFIG_FILE} (previews and local stages get at most ${EMAIL_NON_PROD_DAILY_LIMIT}); the count starts over at 00:00 UTC.`,
  paused: (tenant: string, stage: string): string => {
    const flag = stage === PROD_STAGE ? '' : ` --stage ${stage}`;
    return `email.send: sending is paused for ${tenant}. \`plat email${flag}\` (or the app's Email page in the console) shows why; \`plat email resume${flag}\` resumes it.`;
  },
};

/** Record messages instead of delivering them (`captureEmails` in the testing module). */
type Capture = (mail: CapturedEmail) => void;
let capture: Capture | undefined;

/** `undefined` restores delivery (SES, or the local inbox). */
export function setEmailCapture(c: Capture | undefined): void {
  capture = c;
}

function emailBindings(b: Bindings): EmailBindings {
  if (!b.email)
    throw new Error(
      `Email is not enabled for this app. Add \`email\` to ${APP_CONFIG_FILE} (\`email: true\`, or \`email: { name: 'My App' }\` for a display name).`,
    );
  return b.email;
}

interface Normalized {
  to: string[];
  replyTo: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Sends `message`; throws `EmailRefused` for what the app can handle, anything else is a defect. */
export async function sendEmail(message: EmailMessage): Promise<{ id: string }> {
  const b = getBindings();
  const e = emailBindings(b);
  // The tenant names the span: it's fixed per stage, and recipients don't belong in telemetry.
  return span('email.send', e.tenant, async () => {
    const checked = checkEmailMessage(message);
    if (!checked.ok) throw new EmailRefused('rejected', checked.message);
    const m: Normalized = {
      to: checked.to,
      replyTo: checked.replyTo,
      subject: message.subject,
      text: message.text,
      ...(message.html !== undefined ? { html: message.html } : {}),
    };
    if (capture) {
      const captured = capturedEmail(b, e, m);
      capture(captured);
      return { id: captured.id };
    }
    return e.mode === 'local' ? deliverLocally(b, e, m) : deliverWithSes(b, e, m);
  });
}

function capturedEmail(b: Bindings, e: EmailBindings, m: Normalized): CapturedEmail {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    app: b.app,
    stage: b.stage,
    from: formatMailbox(e.from, e.name),
    ...m,
  };
}

/** `plat dev` / `plat test`: counted like a send, then posted to the CLI's inbox. Nothing reaches SES. */
async function deliverLocally(b: Bindings, e: EmailBindings, m: Normalized): Promise<{ id: string }> {
  const url = process.env[LOCAL_MAIL_URL_ENV];
  if (!url)
    throw new Error(
      `Email runs in local mode here, but ${LOCAL_MAIL_URL_ENV} is not set: run the app with \`plat dev\` or \`plat test\`, or call captureEmails() from @ericminassian/platform/testing in unit tests.`,
    );
  const day = await countRecipients(b, e, m.to.length);
  const captured = capturedEmail(b, e, m);
  try {
    // Uninstrumented: this call is the `email.send` span, not an outgoing fetch.
    const res = await uninstrumentedFetch()(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(captured),
    });
    await res.body?.cancel();
    if (!res.ok) throw new Error(`email.send: the local inbox at ${url} answered ${res.status}`);
  } catch (err) {
    await returnRecipients(b, e, day, m.to.length);
    throw err;
  }
  return { id: captured.id };
}

async function deliverWithSes(b: Bindings, e: EmailBindings, m: Normalized): Promise<{ id: string }> {
  const to = m.to.filter((a) => !isReservedEmailDomain(a));
  const reserved = m.to.filter(isReservedEmailDomain);
  if (reserved.length)
    log.info('email.send: skipped recipients at reserved test domains (they can never receive mail)', {
      skipped: reserved,
    });
  if (to.length === 0) return { id: randomUUID() };

  const day = await countRecipients(b, e, to.length);
  try {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const trace = currentContext()?.trace;
    const out = await (await client('sesv2')).send(
      new SendEmailCommand({
        FromEmailAddress: sesMailbox(e.from, e.name),
        Destination: { ToAddresses: to },
        ...(m.replyTo.length ? { ReplyToAddresses: m.replyTo } : {}),
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: 'UTF-8' },
            Body: {
              ...(m.text ? { Text: { Data: m.text, Charset: 'UTF-8' } } : {}),
              ...(m.html ? { Html: { Data: m.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
        // Both, always: IAM only lets the stage role send as its tenant, and the
        // configuration set is the resource the tenant is tied to.
        ConfigurationSetName: e.tenant,
        TenantName: e.tenant,
        ...(trace && TAG_VALUE.test(trace) ? { EmailTags: [{ Name: 'trace', Value: trace }] } : {}),
      }),
    );
    return { id: out.MessageId ?? randomUUID() };
  } catch (err) {
    await returnRecipients(b, e, day, to.length);
    throw sesFailure(err, e.tenant, b.stage, to);
  }
}

/** SES message tag values: ASCII letters, digits, `_` and `-`, up to 256. */
const TAG_VALUE = /^[A-Za-z0-9_-]{1,256}$/;

/** SES's answer as `EmailRefused` when the app can act on it; anything else stays a defect. */
function sesFailure(err: unknown, tenant: string, stage: string, to: readonly string[]): unknown {
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  // In the SES sandbox every recipient must be a verified identity, and SES authorizes the stage
  // role against each one, so an unverified recipient is AccessDenied on `identity/<address>`
  // rather than a refusal (verified 2026-11-15). The role's own grant is fine: say so.
  if (name === 'AccessDeniedException') {
    const lower = message.toLowerCase();
    const unverified = to.find((a) => lower.includes(`:identity/${a.toLowerCase()}`));
    if (unverified !== undefined)
      return new EmailRefused(
        'rejected',
        `email.send: SES refused ${unverified}: the platform's SES account is still in the sandbox, where SES delivers only to addresses verified in it. That ends when AWS grants it production access (docs/SETUP.md).`,
      );
  }
  // A paused tenant is `MessageRejected: Sending disabled for <tenant ARN>…` (verified 2026-11-15).
  if (
    (name === 'MessageRejected' && /sending disabled/i.test(message)) ||
    name === 'SendingPausedException' ||
    name === 'AccountSuspendedException'
  )
    return new EmailRefused('paused', emailRefusals.paused(tenant, stage));
  if (
    name === 'MessageRejected' ||
    name === 'BadRequestException' ||
    name === 'MailFromDomainNotVerifiedException'
  )
    return new EmailRefused('rejected', `email.send: SES rejected the message: ${message}`);
  return err;
}

// ---------------------------------------------------------------- daily limit

/**
 * The usage row update that counts `recipients` against today's limit: it
 * fails its condition when the day's total would pass `limit`. The first send
 * of a day sets the row's expiry.
 */
export function emailUsageUpdate(opts: {
  table: string;
  app: string;
  stage: string;
  day: string;
  recipients: number;
  limit: number;
}) {
  const dayEnds = Date.parse(`${opts.day}T00:00:00.000Z`) / 1000 + 24 * 3600;
  return {
    TableName: opts.table,
    Key: { pk: telemetryKeys.email(opts.app, opts.stage), sk: opts.day },
    UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl) ADD #n :k',
    ConditionExpression: 'attribute_not_exists(#n) OR #n <= :max',
    // `ttl` is a DynamoDB reserved word.
    ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':k': opts.recipients,
      ':max': opts.limit - opts.recipients,
      ':ttl': dayEnds + EMAIL_USAGE_TTL_SECONDS,
    },
  };
}

/** Counts `k` recipients against today's limit and returns the day they were counted on. */
async function countRecipients(b: Bindings, e: EmailBindings, k: number): Promise<string> {
  // A message larger than the whole limit would pass the condition on a fresh day.
  if (k > e.dailyLimit) throw new EmailRefused('daily-limit', emailRefusals.dailyLimit(e.dailyLimit, k));
  const day = emailUsageDay(Date.now());
  try {
    await ddbClient().send(
      new UpdateCommand(
        emailUsageUpdate({
          table: e.usageTable,
          app: b.app,
          stage: b.stage,
          day,
          recipients: k,
          limit: e.dailyLimit,
        }),
      ),
    );
  } catch (err) {
    if ((err as { name?: unknown } | null)?.name === 'ConditionalCheckFailedException')
      throw new EmailRefused('daily-limit', emailRefusals.dailyLimit(e.dailyLimit, k));
    throw err;
  }
  return day;
}

/** Gives back what a failed send counted. Best effort: a failure only overcounts the day. */
async function returnRecipients(b: Bindings, e: EmailBindings, day: string, k: number): Promise<void> {
  try {
    await ddbClient().send(
      new UpdateCommand({
        TableName: e.usageTable,
        Key: { pk: telemetryKeys.email(b.app, b.stage), sk: day },
        UpdateExpression: 'ADD #n :k',
        ExpressionAttributeNames: { '#n': 'n' },
        ExpressionAttributeValues: { ':k': -k },
      }),
    );
  } catch (err) {
    log.warn("email.send: could not take a failed send off today's count", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------- From header

/**
 * The From mailbox SES takes: `"Name" <address>`, with a non-ASCII name as RFC
 * 2047 encoded-words (SES requires it; they can't go inside quotes).
 */
export function sesMailbox(address: string, name?: string): string {
  if (!name || /^[\x20-\x7e]*$/.test(name)) return formatMailbox(address, name);
  return `${encodedWords(name)} <${address}>`;
}

/**
 * `=?UTF-8?B?…?=` words of at most 75 characters: 45 bytes (60 base64
 * characters) each, split between characters. Readers join adjacent words.
 */
function encodedWords(text: string): string {
  const words: string[] = [];
  let word = '';
  for (const ch of text) {
    if (word && Buffer.byteLength(word + ch) > 45) {
      words.push(word);
      word = '';
    }
    word += ch;
  }
  if (word) words.push(word);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
}
