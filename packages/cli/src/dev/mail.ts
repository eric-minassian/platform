import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type CapturedEmail, EMAIL_INBOX_PATH } from '@ericminassian/platform-core';

/**
 * The inbox of `plat dev` and `plat test`. Nothing is sent locally: the SDK
 * posts each message `Email.send` takes to `PLATFORM_LOCAL_MAIL_URL`, and the
 * inbox keeps the newest ones in memory for the session. The local router
 * serves it on every app host; deployed stages never do.
 *
 *   GET  /__platform/mail             the inbox page (live)
 *   GET  /__platform/mail/<id>        one message
 *   GET  /__platform/mail/<id>/html   its HTML body, sandboxed, for the message page's frame
 *   GET  /__platform/mail/messages    the list as JSON, `{ messages }`, newest first (tests)
 *   POST /__platform/mail/messages    where the SDK delivers (`PLATFORM_LOCAL_MAIL_URL`)
 *   GET  /__platform/mail/events      server-sent events, one per new message (the page's updates)
 */
export interface LocalInbox {
  /** Newest first. */
  messages(): readonly CapturedEmail[];
  add(mail: CapturedEmail): void;
  /** Serves `EMAIL_INBOX_PATH` and below; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Ends the pages' live update streams. */
  close(): void;
}

export const INBOX_CAPACITY = 200;
const MESSAGES_PATH = `${EMAIL_INBOX_PATH}/messages`;
/** SES takes messages up to 40 MB; the SDK sends no attachments, so this is plenty. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
/** Message ids go into URLs as they are: no `/`, `%` or leading dot. */
const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** `PLATFORM_LOCAL_MAIL_URL` for an inbox served at `origin` (`http://127.0.0.1:<port>`). */
export function localMailUrl(origin: string): string {
  return `${origin}${MESSAGES_PATH}`;
}

export function isInboxPath(pathname: string): boolean {
  return pathname === EMAIL_INBOX_PATH || pathname.startsWith(`${EMAIL_INBOX_PATH}/`);
}

export function createInbox(opts: {
  /** The app's name, for the pages. */
  app: string;
  capacity?: number;
  /** Called for each message as it arrives (`plat dev` prints a line). */
  onMessage?: (mail: CapturedEmail) => void;
}): LocalInbox {
  const capacity = opts.capacity ?? INBOX_CAPACITY;
  let messages: CapturedEmail[] = [];
  const streams = new Set<ServerResponse>();

  const add = (mail: CapturedEmail) => {
    messages = [mail, ...messages.filter((m) => m.id !== mail.id)].slice(0, capacity);
    for (const s of streams) s.write(`data: ${JSON.stringify({ id: mail.id })}\n\n`);
    opts.onMessage?.(mail);
  };

  const receive = async (req: IncomingMessage, res: ServerResponse) => {
    // JSON only: a page on another origin can't send that without a preflight, which nothing answers.
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? ''))
      return json(res, 415, { error: 'send the message as application/json' });
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined)
      return json(res, 413, { error: `messages are limited to ${MAX_BODY_BYTES} bytes` });
    let mail: unknown;
    try {
      mail = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'the body is not JSON' });
    }
    if (!isCapturedEmail(mail)) return json(res, 400, { error: 'the body is not a captured message' });
    add(mail);
    json(res, 201, { id: mail.id });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!isInboxPath(url.pathname)) return false;
    const method = req.method ?? 'GET';
    const rest = url.pathname.slice(EMAIL_INBOX_PATH.length).replace(/\/+$/, '');
    if (rest === '/messages') {
      if (method === 'POST') await receive(req, res);
      else if (method === 'GET' || method === 'HEAD') json(res, 200, { messages });
      else notAllowed(res, 'GET, POST');
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      notAllowed(res, 'GET');
      return true;
    }
    if (rest === '') {
      html(res, 200, inboxPage(opts.app, messages));
      return true;
    }
    if (rest === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 1000\n\n');
      streams.add(res);
      req.once('close', () => streams.delete(res));
      return true;
    }
    // Ids are URL-safe (`ID`), so the path segment is the id as is.
    const m = /^\/([^/]+)(\/html)?$/.exec(rest);
    const mail = m ? messages.find((x) => x.id === m[1]) : undefined;
    if (!mail || (m?.[2] && mail.html === undefined)) html(res, 404, notFoundPage(opts.app, capacity));
    else if (m?.[2]) htmlBody(res, mail.html ?? '');
    else html(res, 200, messagePage(opts.app, mail));
    return true;
  };

  return {
    messages: () => messages,
    add,
    handle,
    close: () => {
      for (const s of streams) s.end();
      streams.clear();
    },
  };
}

/**
 * The inbox on its own loopback port, for `plat test` (which runs no router).
 * `url` is its `PLATFORM_LOCAL_MAIL_URL`.
 */
export async function startInboxServer(inbox: LocalInbox): Promise<{ url: string; stop(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    inbox.handle(req, res, url).then(
      (handled) => {
        if (!handled) json(res, 404, { error: 'not found' });
      },
      (err: Error) => {
        if (!res.headersSent) json(res, 500, { error: err.message });
        else res.destroy();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: localMailUrl(`http://127.0.0.1:${port}`),
    stop: () => {
      inbox.close();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function isCapturedEmail(v: unknown): v is CapturedEmail {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  return (
    typeof m.id === 'string' &&
    ID.test(m.id) &&
    typeof m.at === 'string' &&
    !Number.isNaN(Date.parse(m.at)) &&
    ['app', 'stage', 'from', 'subject', 'text'].every((k) => typeof m[k] === 'string') &&
    strings(m.to) &&
    strings(m.replyTo) &&
    (m.html === undefined || typeof m.html === 'string')
  );
}

/** The body as text, or undefined once it passes `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Keep draining so the response can still be written, but stop buffering.
      if (size <= limit) chunks.push(c);
    });
    req.once('end', () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function notAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, { 'content-type': 'application/json', allow });
  res.end(JSON.stringify({ error: `use ${allow}` }));
}

// The inbox's own pages run their one inline script and frame message bodies
// from this origin; nothing else loads.
const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function html(res: ServerResponse, status: number, page: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
  });
  res.end(page);
}

/**
 * A message's HTML as its own document. It runs no scripts and gets an opaque
 * origin, even opened outside the frame (CSP `sandbox`); links open in a new
 * tab outside the sandbox, so a link in the mail (a sign-in link, say) works.
 */
function htmlBody(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline'; font-src * data:; media-src * data:; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  // After a doctype, so the document keeps its mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body)?.[0] ?? '';
  res.end(`${doctype}<base target="_blank">${body.slice(doctype.length)}`);
}

// ---------------------------------------------------------------- pages

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The display name of `"Name" <address>`, else the address: every message in a stage has the same sender. */
const sender = (from: string) => /^"(.+)" <[^>]+>$/.exec(from)?.[1] ?? from;

const messageHref = (id: string) => `${EMAIL_INBOX_PATH}/${id}`;

/** UTC until the page's script shows local time. */
const time = (iso: string) =>
  `<time datetime="${esc(iso)}">${esc(new Date(iso).toISOString().slice(0, 19).replace('T', ' '))} UTC</time>`;

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#6e6e73;--line:#e6e6e8;--hover:#f5f5f7;--accent:#0a66d8;--panel:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--muted:#98989d;--line:#2a2a2e;--hover:#1c1c20;--accent:#6aa5ff;--panel:#1a1a1d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:14px 24px;border-bottom:1px solid var(--line)}
header h1{font-size:15px;font-weight:600;margin:0}
header .count{margin-left:auto;white-space:nowrap}
.muted{color:var(--muted)}
main{max-width:1120px;margin:0 auto;padding:4px 24px 48px}
.row{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr) minmax(0,2.8fr) 9.5rem;gap:16px;padding:9px 8px;border-bottom:1px solid var(--line);color:inherit}
.row>*{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row time{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
a.row:hover{background:var(--hover)}
.heading{font-size:12px;color:var(--muted)}
.subject{font-weight:500}
.empty{padding:40px 8px;color:var(--muted)}
h2{font-size:18px;font-weight:600;margin:20px 0 12px;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0 0 20px}
dt{color:var(--muted)}
dd{margin:0;overflow-wrap:anywhere}
.view{display:flex;flex-wrap:wrap;gap:4px}
.view input{position:absolute;opacity:0;pointer-events:none}
.view label{padding:3px 12px;border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--muted)}
.view input:checked+label{color:var(--fg);background:var(--hover)}
.view input:focus-visible+label{outline:2px solid var(--accent);outline-offset:1px}
.panel{display:none;flex-basis:100%;margin-top:4px}
#view-html:checked~.panel-html,#view-text:checked~.panel-text{display:block}
iframe{display:block;width:100%;height:70vh;border:1px solid var(--line);border-radius:6px;background:#fff}
pre{margin:0;padding:16px;border:1px solid var(--line);border-radius:6px;background:var(--panel);white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
@media (max-width:720px){.row{grid-template-columns:minmax(0,1fr) auto;row-gap:2px}.row .from{display:none}.row .to{grid-column:1/-1;color:var(--muted);font-size:12px}.heading{display:none}header,main{padding-left:16px;padding-right:16px}}
`;

/** Shows times in the browser's time zone; the inbox page also swaps in its list on each new message. */
const script = (live: boolean) => `<script>
const localize = () => {
  const today = new Date().toDateString();
  for (const t of document.querySelectorAll('time[datetime]')) {
    const d = new Date(t.dateTime);
    t.textContent = d.toDateString() === today ? d.toLocaleTimeString() : d.toLocaleString();
  }
};
localize();
${
  live
    ? `new EventSource(${JSON.stringify(`${EMAIL_INBOX_PATH}/events`)}).onmessage = async () => {
  const next = new DOMParser().parseFromString(await (await fetch(location.href)).text(), 'text/html');
  document.querySelector('main').replaceWith(next.querySelector('main'));
  document.querySelector('header .count').textContent = next.querySelector('header .count').textContent;
  document.title = next.title;
  localize();
};`
    : ''
}
</script>`;

function layout(title: string, header: string, main: string, live: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>${header}</header>
<main>${main}</main>
${script(live)}
</body>
</html>`;
}

const inboxHeader = (app: string, count: string) =>
  `<h1>Mail</h1><span class="muted">${esc(app)} · captured locally, nothing is sent</span><span class="count muted">${count}</span>`;

function inboxPage(app: string, messages: readonly CapturedEmail[]): string {
  const count = messages.length === 1 ? '1 message' : `${messages.length} messages`;
  const rows = messages
    .map(
      (m) => `<a class="row" href="${esc(messageHref(m.id))}">
<span class="from" title="${esc(m.from)}">${esc(sender(m.from))}</span><span class="to">${esc(m.to.join(', '))}</span><span class="subject">${esc(m.subject)}</span>${time(m.at)}
</a>`,
    )
    .join('\n');
  const main = messages.length
    ? `<div class="row heading"><span class="from">From</span><span class="to">To</span><span>Subject</span><span></span></div>\n${rows}`
    : '<p class="empty">No messages yet.</p>';
  return layout(
    `Mail · ${app}${messages.length ? ` (${messages.length})` : ''}`,
    inboxHeader(app, count),
    main,
    true,
  );
}

function messagePage(app: string, m: CapturedEmail): string {
  const field = (name: string, value: string) => `<dt>${name}</dt><dd>${value}</dd>`;
  const meta = [
    field('From', esc(m.from)),
    field('To', esc(m.to.join(', '))),
    m.replyTo.length ? field('Reply-To', esc(m.replyTo.join(', '))) : '',
    field('Date', time(m.at)),
  ].join('');
  const text = `<pre>${esc(m.text)}</pre>`;
  const frame = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" src="${esc(`${messageHref(m.id)}/html`)}" title="HTML body" referrerpolicy="no-referrer"></iframe>`;
  // Both bodies: tabs, HTML first, as mail clients show it.
  const body =
    m.html !== undefined && m.text
      ? `<div class="view">
<input type="radio" name="view" id="view-html" checked><label for="view-html">HTML</label>
<input type="radio" name="view" id="view-text"><label for="view-text">Text</label>
<div class="panel panel-html">${frame}</div><div class="panel panel-text">${text}</div>
</div>`
      : m.html !== undefined
        ? frame
        : text;
  const header = `<h1><a href="${EMAIL_INBOX_PATH}">Mail</a></h1><span class="muted">${esc(app)}</span>`;
  return layout(`${m.subject} · Mail`, header, `<h2>${esc(m.subject)}</h2><dl>${meta}</dl>${body}`, false);
}

function notFoundPage(app: string, capacity: number): string {
  const header = `<h1><a href="${EMAIL_INBOX_PATH}">Mail</a></h1><span class="muted">${esc(app)}</span>`;
  return layout(
    'Not found · Mail',
    header,
    `<p class="empty">No such message. The inbox keeps the newest ${capacity} until plat stops.</p>`,
    false,
  );
}
