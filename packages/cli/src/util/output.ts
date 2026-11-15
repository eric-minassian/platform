import pc from 'picocolors';

/**
 * Output conventions: human-readable by default, `--json` prints exactly one
 * JSON document on stdout (progress goes to stderr) so agents can parse it.
 */
export class CliError extends Error {
  readonly hint?: string;
  readonly exitCode: number;
  constructor(message: string, opts: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.hint = opts.hint;
    this.exitCode = opts.exitCode ?? 1;
  }
}

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  deployFailed: 5,
} as const;

export interface OutputOptions {
  json?: boolean;
}

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Progress/status lines; stderr so `--json` stdout stays clean. */
export function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

export function step(msg: string): void {
  info(`${pc.cyan('›')} ${msg}`);
}

export function success(msg: string): void {
  info(`${pc.green('✓')} ${msg}`);
}

export function warn(msg: string): void {
  info(`${pc.yellow('!')} ${msg}`);
}

/** Prints the command result: JSON in `--json` mode, else via `human`. */
export function result<T>(value: T, human: (v: T) => string | undefined): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const text = human(value);
  if (text) process.stdout.write(`${text}\n`);
}

export function formatError(err: unknown): { message: string; hint?: string; exitCode: number } {
  if (err instanceof CliError) return { message: err.message, hint: err.hint, exitCode: err.exitCode };
  if (err instanceof Error) return { message: err.message, exitCode: EXIT.error };
  return { message: String(err), exitCode: EXIT.error };
}

export function reportError(err: unknown): number {
  const { message, hint, exitCode } = formatError(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ error: { message, hint, exitCode } }, null, 2)}\n`);
  } else {
    info(`${pc.red('✗')} ${message}`);
    if (hint) info(`  ${pc.dim(hint)}`);
  }
  return exitCode;
}

/** Plain-text table with padded columns. */
export function table(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return pc.dim('(none)');
  const cols = columns ?? Object.keys(rows[0]!);
  const cell = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null) return JSON.stringify(v);
    // Not JSON.stringify for these: it throws on a bigint and drops a symbol.
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || typeof v === 'symbol')
      return v.toString();
    return '';
  };
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => visibleLength(cell(r[c])))));
  const line = (vals: string[]) =>
    vals.map((v, i) => v + ' '.repeat(widths[i]! - visibleLength(v))).join('  ');
  return [pc.bold(line(cols)), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

// oxlint-disable-next-line eslint/no-control-regex -- matching ANSI escape codes is the point
const ANSI = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}

const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** Unicode sparkline; nulls render as spaces. */
export function sparkline(values: Array<number | null>): string {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return '';
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return values
    .map((v) => {
      if (v === null || !Number.isFinite(v)) return ' ';
      if (max === min) return v === 0 ? SPARKS[0] : SPARKS[3];
      return SPARKS[Math.round(((v - min) / (max - min)) * (SPARKS.length - 1))];
    })
    .join('');
}
