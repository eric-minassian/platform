import { type CapturedEmail, isTelemetryEvent, type TelemetryEvent } from '@ericminassian/platform-core';
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
      return `${pc.bold(e.method.padEnd(6))} ${e.path ?? e.route} ${color(String(e.status))} ${pc.dim(`${Math.round(e.dur)}ms`)}${e.cold ? pc.magenta(' cold') : ''}${trace}`;
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
      // A service job without a unit name is a run of the service itself that ended.
      if (e.kind === 'service' && !e.name.includes('/')) {
        const outcome = e.status === 'ok' ? pc.yellow('returned') : pc.red('failed');
        return `${pc.cyan('service')} ${e.name} run ${outcome} ${pc.dim(`after ${formatDuration(e.dur)}`)}${trace}`;
      }
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
      return pc.blue(`metric ${e.name}=${e.value}${e.unit ? ` ${e.unit}` : ''}`);
    // Only refusals: a line per allowed check would drown the requests.
    case 'limit':
      return e.ok ? null : pc.yellow(`rate limit ${e.name}: over`);
    case 'env': {
      const what = e.runtime === 'service' && e.name ? `service ${e.name}` : `${e.runtime} environment`;
      const detail = e.reason ?? (e.initMs !== undefined ? `${Math.round(e.initMs)}ms init` : undefined);
      return pc.dim(`${what} ${e.event}${detail ? ` (${detail})` : ''}`);
    }
    case 'span':
      return opts.spans
        ? pc.dim(`  span ${e.op}${e.name ? ` ${e.name}` : ''} ${Math.round(e.dur)}ms ${e.status}`)
        : null;
    default:
      // Every type this CLI knows is handled above; one from a newer SDK prints nothing.
      e satisfies never;
      return null;
  }
}

/** One captured message, for the dev terminal: who it's to, its subject, and where to read it. */
export function formatMail(mail: CapturedEmail, url: string): string {
  return `to ${mail.to.join(', ')} ${pc.dim('·')} ${mail.subject} ${pc.dim(url)}`;
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

/** `850ms`, `4.2s`, `3m 05s`, `2h 10m`: a service run can last days. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ${String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
