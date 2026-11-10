/**
 * Local control server for job-apply. Loopback only, no dependencies.
 *
 *   node ui/server.mjs [--port 4780] [--host 127.0.0.1]
 *        [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>]
 *
 * The server is a thin transport: parsing, validation, ledger rules, and the
 * prepare/apply job queue all live in `ui/handlers.mjs`.
 */
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from '../scripts/browser.mjs';
import { createHandlers } from './handlers.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const USAGE = [
  'usage: node ui/server.mjs [--port 4780] [--host 127.0.0.1]',
  '       [--store <applications.json>] [--profile <profile.json>] [--events <events.jsonl>]',
  '',
  'Serves the control page on a loopback address. Browser jobs are queued and',
  'reported through GET /api/job/:id and the /api/stream event feed; nothing is',
  'submitted unless the request carries dryRun: false and the stored company',
  'name as confirm.',
].join('\n');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

function isLoopback(host) {
  const value = String(host).toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  const octets = value.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

const host = String(args.host ?? '127.0.0.1');
if (!isLoopback(host)) {
  console.error(`refusing to bind ${host}: the UI only listens on a loopback address`);
  console.error(USAGE);
  process.exit(2);
}

const portText = String(args.port ?? process.env.PORT ?? '4780');
const port = Number(portText);
if (!/^\d+$/.test(portText) || port > 65535) {
  console.error(`invalid port ${JSON.stringify(portText)}`);
  console.error(USAGE);
  process.exit(2);
}

const handlers = createHandlers({
  storePath: resolve(args.store ?? join(ROOT, 'applications.json')),
  profilePath: resolve(args.profile ?? join(ROOT, 'data/profile.json')),
  eventsPath: resolve(args.events ?? join(ROOT, 'data/events.jsonl')),
  uiPath: join(ROOT, 'ui/index.html'),
  root: ROOT,
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

const server = createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    // The event feed stays open, so it never goes through the request/response
    // handler that returns one JSON body.
    if (url.pathname === '/api/stream') {
      handlers.openStream(res);
      return;
    }
    const result = handlers.handle({ method: req.method, path: url.pathname, query: url.searchParams, body });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (error) {
    // Transport failures keep the shared failure shape instead of raw prose.
    const status = error instanceof HttpError ? error.status : 400;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        code: 'usage',
        message: error.message,
        fix: 'reload the page and retry the action',
        error: error.message,
      }),
    );
  }
});

server.on('error', (error) => {
  console.error(`ui server failed: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`job-apply ui on http://${host}:${server.address().port}`);
});
