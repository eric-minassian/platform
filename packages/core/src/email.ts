/**
 * Email: transactional mail on Amazon SES.
 *
 * - The foundation verifies one domain, `mail.<zone>` (`emailDomain`), with
 *   DKIM, a custom MAIL FROM and DMARC. Every app sends from it.
 * - Each stage that declares `email` is an SES tenant with its own
 *   configuration set (both `names.emailTenant`). SES keeps the tenant's
 *   suppression list, reports its metrics and pauses it on its own when its
 *   bounces or complaints get bad, so one app can't spoil mail for the rest.
 * - The stage role may send only as its tenant and from its own address.
 * - The SDK counts recipients per UTC day against the stage's limit, in the
 *   platform's telemetry table (`telemetryKeys.email`).
 * - Under `plat dev` and `plat test` nothing is sent: the SDK posts each
 *   message to the CLI, which shows it at `EMAIL_INBOX_PATH`.
 *
 * Isomorphic: the SDK, the engine, the CLI and the control plane share it.
 */
import { PROD_STAGE } from './constants.ts';

/** `plat dev`'s local inbox on every app host (served by the local router, never deployed). */
export const EMAIL_INBOX_PATH = '/__platform/mail';
/** Environment variable with the URL the SDK posts captured mail to (`plat dev`, `plat test`). */
export const LOCAL_MAIL_URL_ENV = 'PLATFORM_LOCAL_MAIL_URL';

/** Recipients per UTC day when `email.dailyLimit` isn't set. */
export const EMAIL_DEFAULT_DAILY_LIMIT = 200;
/** Previews and local stages get at most this many recipients a day, whatever the app declares. */
export const EMAIL_NON_PROD_DAILY_LIMIT = 50;
/** SES accepts at most 50 recipients per message. */
export const EMAIL_MAX_RECIPIENTS = 50;
/** Usage rows outlive their day by this much, so the console can show yesterday. */
export const EMAIL_USAGE_TTL_SECONDS = 3 * 24 * 3600;
/**
 * Local part of the user pool's sender. `login` is a reserved app name, so no
 * app's address can ever be the same.
 */
export const EMAIL_LOGIN_LOCAL_PART = 'login';

/** A display name for `email.name`: no quotes, angle brackets, backslashes or line breaks. */
export const EMAIL_NAME_PATTERN = /^[^"<>\\\r\n]{1,64}$/;
export const EMAIL_NAME_MESSAGE =
  'must be 1-64 characters without quotes, angle brackets, backslashes or line breaks';

/** The domain every app sends from: `mail.<zone>` (`mail.platform.ericminassian.com`). */
export function emailDomain(zone: string): string {
  return `mail.${zone}`;
}

/** The custom MAIL FROM (bounce) domain under `domain`, for SPF alignment. */
export function emailMailFromDomain(domain: string): string {
  return `bounce.${domain}`;
}

/** A stage's sender: `todo@<domain>` in prod, `todo--pr-12@<domain>` elsewhere. */
export function emailFromAddress(app: string, stage: string, domain: string): string {
  return stage === PROD_STAGE ? `${app}@${domain}` : `${app}--${stage}@${domain}`;
}

/** Recipients a stage may send to per UTC day: the declared limit, capped outside prod. */
export function emailDailyLimit(stage: string, declared: number): number {
  return stage === PROD_STAGE ? declared : Math.min(declared, EMAIL_NON_PROD_DAILY_LIMIT);
}

/** The UTC day a send counts against (`YYYY-MM-DD`): the usage row's sort key. */
export function emailUsageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** `"Name" <address>`, or the bare address. */
export function formatMailbox(address: string, name?: string): string {
  return name ? `"${name}" <${address}>` : address;
}

// ---------------------------------------------------------------- recipients

/**
 * A pragmatic address check: one `@`, no whitespace, quotes, angle brackets,
 * commas or semicolons, a dotted domain, and SMTP's length limits. SES checks
 * the rest.
 */
const ADDRESS =
  /^[^\s@"<>(),;:\\[\]]{1,64}@(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/** Domains that can never receive mail (RFC 2606 and RFC 6761). */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['test', 'example', 'invalid', 'localhost'];

/**
 * True for addresses at reserved domains (`alice@example.com`, `bob@app.test`).
 * Deployed stages log these instead of sending them: they always bounce, and
 * bounces from test data would count against the app's reputation.
 */
export function isReservedEmailDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return RESERVED_TLDS.includes(tld) || domain === 'localhost';
}

// ---------------------------------------------------------------- the message

/** What `Email.send` takes. */
export interface EmailMessage {
  /** One address or up to 50. Each counts once against the daily limit. */
  readonly to: string | readonly string[];
  readonly subject: string;
  /** Plain-text body. */
  readonly text: string;
  /** HTML body, shown by clients that render HTML (they fall back to `text`). */
  readonly html?: string;
  /** Where replies go; the sending address takes no mail. */
  readonly replyTo?: string | readonly string[];
}

/** Why a message wasn't sent. */
export type EmailNotSentReason =
  /** The stage's recipients for today would pass `email.dailyLimit`. */
  | 'daily-limit'
  /** SES paused the app's sending (its reputation policy, the owner, or AWS). */
  | 'paused'
  /** The message is invalid, or SES refused it. */
  | 'rejected';

const asList = (v: string | readonly string[] | undefined): string[] =>
  v === undefined ? [] : typeof v === 'string' ? [v] : [...v];

/** The message's recipients and reply-to addresses, normalized, or why it can't be sent. */
export function checkEmailMessage(
  m: EmailMessage,
): { ok: true; to: string[]; replyTo: string[] } | { ok: false; message: string } {
  const to = asList(m.to).map((a) => a.trim());
  const replyTo = asList(m.replyTo).map((a) => a.trim());
  if (to.length === 0) return { ok: false, message: 'email.send needs at least one recipient in `to`' };
  if (to.length > EMAIL_MAX_RECIPIENTS)
    return {
      ok: false,
      message: `email.send takes at most ${EMAIL_MAX_RECIPIENTS} recipients (got ${to.length}); send several messages`,
    };
  const bad = [...to, ...replyTo].find((a) => !isEmailAddress(a));
  if (bad !== undefined) return { ok: false, message: `email.send: "${bad}" is not an email address` };
  if (!m.subject.trim()) return { ok: false, message: 'email.send needs a subject' };
  if (/[\r\n]/.test(m.subject)) return { ok: false, message: 'email.send: the subject must be one line' };
  if (!m.text && !m.html) return { ok: false, message: 'email.send needs a `text` body' };
  return { ok: true, to, replyTo };
}

// ---------------------------------------------------------------- plat dev / plat test

/** One message as the CLI's local inbox keeps it (what the SDK posts to `LOCAL_MAIL_URL_ENV`). */
export interface CapturedEmail {
  /** Message id, as `Email.send` returned it. */
  id: string;
  /** ISO time it was captured. */
  at: string;
  app: string;
  stage: string;
  /** `"Name" <address>`. */
  from: string;
  to: readonly string[];
  replyTo: readonly string[];
  subject: string;
  text: string;
  html?: string;
}
