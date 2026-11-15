import { isTelemetryEvent, type TelemetryEvent } from '@ericminassian/platform-core';
import pc from 'picocolors';

/**
 * Human formatting for telemetry lines (`{"_p":1,...}`) printed by the SDK in
 * the local web server and worker. Non-telemetry lines pass through as-is.
 * Returns null for lines that are noise locally (spans, Lambda START/END).
 */
export function prettyLine(line: string, opts: { spans?: boolean } = {}): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^(START|END) RequestId:/.test(trimmed)) return null;
  if (trimmed.startsWith('REPORT RequestId:')) {
    const dur = /Duration: ([\d.]+) ms/.exec(trimmed)?.[1];
    return pc.dim(`lambda invocation ${dur ? `${Math.round(Number(dur))}ms` : 'done'}`);
  }
  // Lambda prefixes console output with "<ts>\t<requestId>\t<LEVEL>\t" in text log format.
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) return trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(jsonStart));
  } catch {
    return trimmed;
  }
  if (!isTelemetryEvent(parsed)) return trimmed;
  return formatEvent(parsed, opts);
}

export function formatEvent(e: TelemetryEvent, opts: { spans?: boolean } = {}): string | null {
  const trace = e.trace ? pc.dim(` ${e.trace.slice(0, 8)}`) : '';
  switch (e.t) {
    case 'req': {
      const color = e.status >= 500 ? pc.red : e.status >= 400 ? pc.yellow : pc.green;
      return `${pc.bold(e.method.padEnd(6))} ${e.path} ${color(String(e.status))} ${pc.dim(`${Math.round(e.dur)}ms`)}${e.cold ? pc.magenta(' cold') : ''}${trace}`;
    }
    case 'err': {
      const head = `${pc.red('✗')} ${pc.red(`${e.name}: ${e.message}`)}${e.route ? pc.dim(` at ${e.route}`) : ''}${e.job ? pc.dim(` in ${e.job}`) : ''}${trace}`;
      const stack = e.stack
        ?.split('\n')
        .slice(1, 4)
        .map((l) => pc.dim(`    ${l.trim()}`))
        .join('\n');
      return stack ? `${head}\n${stack}` : head;
    }
    case 'job': {
      const status = e.status === 'ok' ? pc.green('ok') : pc.red('error');
      return `${pc.cyan('job')} ${e.kind}:${e.name} ${status} ${pc.dim(`${Math.round(e.dur)}ms`)}${e.attempt && e.attempt > 1 ? pc.yellow(` attempt ${e.attempt}`) : ''}${trace}`;
    }
    case 'log': {
      const { _p, t, ts, app, stage, rev, trace: tr, span, parent, level, msg, ...fields } = e;
      const color =
        level === 'error'
          ? pc.red
          : level === 'warn'
            ? pc.yellow
            : level === 'debug'
              ? pc.dim
              : (s: string) => s;
      const extra = Object.keys(fields).length ? pc.dim(` ${JSON.stringify(fields)}`) : '';
      return `${color(level.toUpperCase().padEnd(5))} ${msg}${extra}${trace}`;
    }
    case 'metric':
      return pc.blue(`metric ${e.name}=${e.value}${e.unit ? e.unit : ''}`);
    case 'env':
      return pc.dim(
        `${e.runtime} environment ${e.event}${e.initMs !== undefined ? ` (${Math.round(e.initMs)}ms init)` : ''}`,
      );
    case 'span':
      return opts.spans
        ? pc.dim(`  span ${e.op}${e.name ? ` ${e.name}` : ''} ${Math.round(e.dur)}ms ${e.status}`)
        : null;
  }
}

/** Prefix every line of a child process stream. */
export function prefixer(label: string, write: (s: string) => void, opts: { spans?: boolean } = {}) {
  let buf = '';
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const pretty = prettyLine(line, opts);
      if (pretty !== null) write(`${label} ${pretty.split('\n').join(`\n${label} `)}\n`);
      idx = buf.indexOf('\n');
    }
  };
}
