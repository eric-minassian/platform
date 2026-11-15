import { describe, expect, it } from 'vitest';
import {
  checkEmailMessage,
  EMAIL_DEFAULT_DAILY_LIMIT,
  EMAIL_MAX_RECIPIENTS,
  EMAIL_NON_PROD_DAILY_LIMIT,
  emailDailyLimit,
  emailDomain,
  emailFromAddress,
  emailUsageDay,
  formatMailbox,
  isEmailAddress,
  isReservedEmailDomain,
  ManifestError,
  names,
  parseManifest,
  telemetryKeys,
} from '../src/index.ts';

describe('email manifest', () => {
  it('is off unless declared', () => {
    expect(parseManifest({ name: 'todo' }).email).toBeUndefined();
    expect(parseManifest({ name: 'todo', email: false }).email).toBeUndefined();
  });

  it('defaults the daily limit and keeps the display name', () => {
    expect(parseManifest({ name: 'todo', email: true }).email).toEqual({
      dailyLimit: EMAIL_DEFAULT_DAILY_LIMIT,
    });
    expect(parseManifest({ name: 'todo', email: { name: 'Todo', dailyLimit: 500 } }).email).toEqual({
      name: 'Todo',
      dailyLimit: 500,
    });
  });

  it('rejects display names that would break the From header, and bad limits', () => {
    for (const name of ['Bad "quote"', 'a<b>', 'two\nlines', '', 'x'.repeat(65)])
      expect(() => parseManifest({ name: 'todo', email: { name } })).toThrow(ManifestError);
    expect(() => parseManifest({ name: 'todo', email: { dailyLimit: 0 } })).toThrow(/email\.dailyLimit/);
  });
});

describe('email naming', () => {
  it('gives each stage its own sender and tenant', () => {
    const domain = emailDomain('platform.example.com');
    expect(domain).toBe('mail.platform.example.com');
    expect(emailFromAddress('todo', 'prod', domain)).toBe('todo@mail.platform.example.com');
    expect(emailFromAddress('todo', 'pr-12', domain)).toBe('todo--pr-12@mail.platform.example.com');
    expect(names.emailTenant('todo', 'pr-12')).toBe('todo--pr-12');
    expect(names.emailTenant('a'.repeat(30), 'b'.repeat(20)).length).toBeLessThanOrEqual(64);
    expect(telemetryKeys.email('todo', 'prod')).toBe('mail#todo#prod');
  });

  it('caps the limit outside prod', () => {
    expect(emailDailyLimit('prod', 1000)).toBe(1000);
    expect(emailDailyLimit('pr-3', 1000)).toBe(EMAIL_NON_PROD_DAILY_LIMIT);
    expect(emailDailyLimit('local', 10)).toBe(10);
  });

  it('counts by UTC day and formats mailboxes', () => {
    expect(emailUsageDay(Date.UTC(2026, 10, 15, 23, 59))).toBe('2026-11-15');
    expect(formatMailbox('todo@mail.x', 'Todo')).toBe('"Todo" <todo@mail.x>');
    expect(formatMailbox('todo@mail.x')).toBe('todo@mail.x');
  });
});

describe('email recipients', () => {
  it('accepts ordinary addresses and refuses malformed ones', () => {
    for (const a of ['alice@gmail.com', 'a.b+tag@sub.example.co.uk', "o'neil@x.io"])
      expect(isEmailAddress(a), a).toBe(true);
    for (const a of ['alice', 'alice@', '@x.com', 'a b@x.com', 'a@x', 'a@-x.com', '"a"@x.com', 'a@x.com>'])
      expect(isEmailAddress(a), a).toBe(false);
  });

  it('knows the domains that never take mail', () => {
    for (const a of ['a@example.com', 'a@mail.example.org', 'a@app.test', 'a@x.invalid', 'a@localhost'])
      expect(isReservedEmailDomain(a), a).toBe(true);
    for (const a of ['a@gmail.com', 'a@examples.com', 'a@test.com'])
      expect(isReservedEmailDomain(a), a).toBe(false);
  });

  it('checks a message before it is sent', () => {
    const ok = checkEmailMessage({ to: ' a@x.com ', subject: 'Hi', text: 'Hello', replyTo: 'b@x.com' });
    expect(ok).toEqual({ ok: true, to: ['a@x.com'], replyTo: ['b@x.com'] });
    const fail = (m: Parameters<typeof checkEmailMessage>[0]) => {
      const r = checkEmailMessage(m);
      return r.ok ? undefined : r.message;
    };
    expect(fail({ to: [], subject: 'Hi', text: 'x' })).toMatch(/at least one recipient/);
    expect(
      fail({
        to: Array.from({ length: EMAIL_MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.com`),
        subject: 'Hi',
        text: 'x',
      }),
    ).toMatch(/at most 50/);
    expect(fail({ to: 'nope', subject: 'Hi', text: 'x' })).toMatch(/"nope" is not an email address/);
    expect(fail({ to: 'a@x.com', subject: 'Hi', text: 'x', replyTo: ['bad'] })).toMatch(/"bad"/);
    expect(fail({ to: 'a@x.com', subject: ' ', text: 'x' })).toMatch(/needs a subject/);
    expect(fail({ to: 'a@x.com', subject: 'a\nBcc: evil@x.com', text: 'x' })).toMatch(/one line/);
    expect(fail({ to: 'a@x.com', subject: 'Hi', text: '' })).toMatch(/text/);
    expect(fail({ to: 'a@x.com', subject: 'Hi', text: '', html: '<p>Hi</p>' })).toBeUndefined();
  });
});
