/**
 * Manifests use standard 5-field cron (`min hour day-of-month month day-of-week`,
 * UTC by default) or EventBridge `rate(...)`. EventBridge Scheduler wants its own
 * 6-field `cron(...)` dialect, so the engine converts with {@link toSchedulerExpression}.
 */

const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function isRateExpression(expr: string): boolean {
  return /^rate\(\s*\d+\s+(minute|minutes|hour|hours|day|days)\s*\)$/.test(expr.trim());
}

export function validateCron(expr: string): string | null {
  if (isRateExpression(expr)) return null;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    return `cron "${expr}" must have 5 fields (min hour dom month dow) or be rate(...)`;
  const ok = /^[0-9A-Za-z*,/\-?LW#]+$/;
  for (const f of fields) if (!ok.test(f)) return `cron "${expr}" has an invalid field "${f}"`;
  return null;
}

/** `"0 8 * * 1-5"` → `"cron(0 8 ? * 2-6 *)"`; `rate(...)` passes through. */
export function toSchedulerExpression(expr: string): string {
  const trimmed = expr.trim();
  if (isRateExpression(trimmed)) return trimmed;
  const err = validateCron(trimmed);
  if (err) throw new Error(err);
  let [min, hour, dom, month, dow] = trimmed.split(/\s+/) as [string, string, string, string, string];
  // EventBridge requires exactly one of day-of-month / day-of-week to be `?`.
  if (dow === '*' || dow === '?') {
    dow = '?';
    if (dom === '?') dom = '*';
  } else {
    dow = convertDow(dow);
    dom = '?';
  }
  return `cron(${min} ${hour} ${dom} ${month} ${dow} *)`;
}

/** Unix cron uses 0-6 (or 7) = SUN..SAT; EventBridge uses 1-7 = SUN..SAT. */
function convertDow(field: string): string {
  // Step values (`*/2`) and `#` occurrence numbers (`1#3`) are not weekdays.
  return field.replace(/(?<![/#])\d+/g, (d) => {
    const n = Number(d) % 7;
    return String(n + 1);
  });
}

export function dowName(n: number): string {
  return DOW_NAMES[n % 7]!;
}
