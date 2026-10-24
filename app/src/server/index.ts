// The web server: the JSON API under /api and the built page. Runs and the suite stream their
// progress as server-sent events over the POST response.

import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from './config';
import { chAdmin, pgBench, readerTypes, waitForEngines } from './db';
import { app as appState, getBusy, tryLock } from './state';
import { detectState, runDelete, runSeed, updateEta } from './seed/seeder';
import { getSizes } from './seed/sizes';
import { cancelRun, explain, prepareRun, registerRun, runPair, runSuite } from './bench/runner';
import { GuardError } from './bench/guard';
import { PRESETS, getPreset } from '../shared/presets';
import { TEMPLATES } from '../shared/templates';
import { TABLES } from '../shared/schema';
import type { ApiError, Engine, JobKind, RowsResponse, Sizes, Status } from '../shared/types';

const server = Fastify({ logger: false, bodyLimit: 256 * 1024 });

// ---- Request checks ----

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(name) || name.endsWith('.localhost') || config.extraHosts.includes(name);
}

server.addHook('onRequest', async (req, reply) => {
  if (!hostAllowed(req.headers.host)) {
    return reply.code(403).send({ error: 'Open this page at http://localhost (or set ALLOWED_HOSTS).' } satisfies ApiError);
  }
  // A page on another site can't call the API: browsers always send Origin on cross-site requests.
  // A sandboxed frame or a file:// page sends "null", which is refused too.
  const origin = req.headers.origin;
  if (origin) {
    let host: string | undefined;
    try {
      host = new URL(origin).host;
    } catch {
      host = undefined;
    }
    if (!hostAllowed(host)) return reply.code(403).send({ error: 'Cross-site requests are not allowed.' } satisfies ApiError);
  }
});

// JSON only. Without the text/plain parser a plain HTML form can't post to the API.
server.removeContentTypeParser('text/plain');

const fail = (reply: FastifyReply, code: number, error: string, busy?: ApiError['busy']) =>
  reply.code(code).send({ error, ...(busy !== undefined && { busy }) } satisfies ApiError);

const BUSY_TEXT: Record<JobKind, string> = {
  seed: 'Data is being generated.',
  delete: 'Data is being deleted.',
  run: 'Another query is running (maybe in another tab).',
  suite: 'The full suite is running (maybe in another tab).',
  explain: 'An Explain is running.',
  browse: 'Rows are being read for the data browser.',
};

// Takes the global lock, or answers 409 and returns null.
function lockOr409(kind: JobKind, reply: FastifyReply): (() => void) | null {
  const release = tryLock(kind);
  if (!release) {
    const busy = getBusy();
    fail(reply, 409, busy ? BUSY_TEXT[busy.kind] : 'Busy.', busy);
  }
  return release;
}

function requireReady(reply: FastifyReply): boolean {
  if (appState.state === 'ready') return true;
  fail(reply, 409, 'The dataset is not ready yet.');
  return false;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- Status and dataset ----

let lastSizes: Sizes | null = null;

server.get('/api/status', async (): Promise<Status> => {
  const busy = getBusy();
  // Sizes are measured with queries of their own, so leave the engines alone while a query is timed.
  const timing = busy && (busy.kind === 'run' || busy.kind === 'suite' || busy.kind === 'explain');
  if (appState.state !== 'starting' && !timing) {
    const job = busy?.kind === 'seed' || busy?.kind === 'delete';
    // During a load the size queries take up to seconds; the progress shouldn't wait for them.
    if (job && lastSizes) {
      void getSizes(true).then((s) => {
        lastSizes = s;
      });
    } else {
      lastSizes = await getSizes(job);
    }
  }
  // After the sizes, so the ETA goes with the progress this answer carries.
  if (appState.progress) updateEta(appState.progress);
  return {
    state: appState.state,
    meta: appState.meta,
    sizes: appState.state === 'starting' ? null : lastSizes,
    progress: appState.progress,
    busy,
    error: appState.error,
    incompleteReason: appState.incompleteReason,
    lastFreedBytes: appState.lastFreedBytes,
    baselineMs: appState.baselineMs,
    presets: PRESETS,
  };
});

const IDLE_STATES = new Set(['empty', 'incomplete', 'ready', 'error']);

// Starts a background job; the response returns at once and the page polls /api/status.
function startJob(kind: 'seed' | 'delete', reply: FastifyReply, job: () => Promise<void>) {
  if (!IDLE_STATES.has(appState.state)) return fail(reply, 409, 'The databases are not ready for that yet.');
  const release = lockOr409(kind, reply);
  if (!release) return reply;
  void job()
    .catch((err) => console.error(`${kind} failed:`, err))
    .finally(release);
  return reply.code(202).send({ ok: true });
}

server.post('/api/dataset', async (req, reply) => {
  const preset = getPreset(String((req.body as { preset?: unknown } | null)?.preset ?? ''));
  if (!preset) return fail(reply, 400, 'Unknown size preset.');
  return startJob('seed', reply, () => runSeed(preset));
});

server.delete('/api/dataset', async (_req, reply) => startJob('delete', reply, runDelete));

// Re-reads what is on disk, for the Retry button after a failed start.
server.post('/api/recheck', async (_req, reply) => {
  if (!IDLE_STATES.has(appState.state)) return fail(reply, 409, 'The databases are busy.');
  if (getBusy()) return fail(reply, 409, BUSY_TEXT[getBusy()!.kind], getBusy());
  await detectState();
  return { ok: true };
});

// One page of a table from both engines, for the data browser. Ids are dense (1…N), so a page
// is an id range: a primary-key range scan on Postgres and a scan of the id column on ClickHouse.
const PAGE_SIZE_MIN = 10;
const PAGE_SIZE_MAX = 100;

async function readRows(table: string, from: number, to: number) {
  const sql = `SELECT * FROM ${table} WHERE id BETWEEN ${from} AND ${to} ORDER BY id`;
  const pg = await pgBench().query({ text: sql, rowMode: 'array', types: readerTypes });
  const rs = await chAdmin.query({ query: sql.replace(table, `bench.${table}`), format: 'JSONCompactEachRowWithNames' });
  const [names = [], ...rows] = (await rs.json()) as unknown[][];
  return {
    pg: { columns: pg.fields.map((f) => f.name), rows: pg.rows as unknown[][] },
    ch: { columns: names as string[], rows },
  };
}

server.get('/api/dataset/rows', async (req, reply) => {
  if (!requireReady(reply)) return reply;
  const q = req.query as Record<string, string | undefined>;
  const table = TABLES.find((t) => t.name === q.table)?.name;
  if (!table) return fail(reply, 400, 'Unknown table.');
  const page = Number(q.page ?? 1);
  const pageSize = Number(q.pageSize ?? 25);
  if (!Number.isInteger(page) || page < 1) return fail(reply, 400, 'The page must be a whole number from 1.');
  if (!Number.isInteger(pageSize) || pageSize < PAGE_SIZE_MIN || pageSize > PAGE_SIZE_MAX) {
    return fail(reply, 400, `The page size must be ${PAGE_SIZE_MIN}–${PAGE_SIZE_MAX}.`);
  }
  const meta = appState.meta;
  if (!meta) return fail(reply, 409, 'The dataset is not ready yet.');
  const total = table === 'orders' ? meta.orders : meta.users;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const shown = Math.min(page, pages);
  // Reading holds the lock, so it never runs alongside a timed query.
  const release = lockOr409('browse', reply);
  if (!release) return reply;
  try {
    const from = (shown - 1) * pageSize + 1;
    const rows = await readRows(table, from, from + pageSize - 1);
    return { table, page: shown, pageSize, total, pages, ...rows } satisfies RowsResponse;
  } catch (err) {
    return fail(reply, 500, `Could not read rows: ${errorText(err)}`);
  } finally {
    release();
  }
});

server.get('/api/templates', async () => TEMPLATES);

// ---- Running queries ----

// Answers with an event stream. `work` gets a send function and an abort signal; closing the
// tab (or the cancel route) aborts it.
async function stream(
  req: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  signal: AbortSignal,
  work: (send: (event: object) => void) => Promise<void>,
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.on('close', () => {
    if (!res.writableFinished) cancelRun(runId);
  });
  const send = (event: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  try {
    await work(send);
  } catch (err) {
    console.error(`${req.url} failed:`, err);
    send({ type: 'error', message: errorText(err) });
  } finally {
    res.end();
  }
}

server.post('/api/run', async (req, reply) => {
  if (!requireReady(reply)) return reply;
  let input;
  try {
    input = prepareRun(req.body);
  } catch (err) {
    if (err instanceof GuardError) return fail(reply, 400, err.message);
    throw err;
  }
  const release = lockOr409('run', reply);
  if (!release) return reply;
  const { runId, signal, finish } = registerRun();
  try {
    await stream(req, reply, runId, signal, async (send) => {
      const result = await runPair(input, send, signal, runId);
      send({ type: 'done', result });
    });
  } finally {
    finish();
    release();
  }
});

server.post('/api/suite', async (req, reply) => {
  if (!requireReady(reply)) return reply;
  const runs = (req.body as { runs?: unknown } | null)?.runs ?? 3;
  if (runs !== 1 && runs !== 3 && runs !== 5) return fail(reply, 400, '"runs" must be 1, 3 or 5.');
  const release = lockOr409('suite', reply);
  if (!release) return reply;
  const { runId, signal, finish } = registerRun();
  try {
    await stream(req, reply, runId, signal, (send) => runSuite(runs, send, signal, runId));
  } finally {
    finish();
    release();
  }
});

server.post('/api/run/:id/cancel', async (req, reply) => {
  const found = cancelRun((req.params as { id: string }).id);
  return reply.code(found ? 202 : 404).send({ ok: found });
});

server.post('/api/explain', async (req, reply) => {
  if (!requireReady(reply)) return reply;
  const body = (req.body ?? {}) as { engine?: unknown; sql?: unknown };
  if (body.engine !== 'pg' && body.engine !== 'ch') return fail(reply, 400, '"engine" must be "pg" or "ch".');
  if (typeof body.sql !== 'string' || body.sql.length > 20_000) return fail(reply, 400, '"sql" is required.');
  const release = lockOr409('explain', reply);
  if (!release) return reply;
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  try {
    return await explain(body.engine as Engine, body.sql, abort.signal);
  } catch (err) {
    if (err instanceof GuardError) return fail(reply, 400, err.message);
    throw err;
  } finally {
    release();
  }
});

server.all('/api/*', async (_req, reply) => fail(reply, 404, 'No such API route.'));

server.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  const code = e.statusCode && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
  if (code === 500) console.error(err);
  return fail(reply, code, code === 415 ? 'Send JSON (Content-Type: application/json).' : e.message);
});

// ---- The page ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};

async function sendFile(reply: FastifyReply, path: string) {
  const body = await readFile(path);
  const type = MIME[extname(path)] ?? 'application/octet-stream';
  // Vite puts a content hash in every file name under assets/, so those never change.
  const cache = path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  return reply.type(type).header('Cache-Control', cache).send(body);
}

server.get('/*', async (req, reply) => {
  const root = normalize(config.clientDir);
  const rel = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
  const file = normalize(join(root, rel));
  if (rel && file.startsWith(root + sep)) {
    try {
      return await sendFile(reply, file);
    } catch {
      // Not a file: fall through to the page.
    }
  }
  try {
    return await sendFile(reply, join(root, 'index.html'));
  } catch {
    return reply.code(503).type('text/plain').send('The page has not been built. Run "npm run build" in app/.');
  }
});

// ---- Start ----

async function main() {
  await server.listen({ host: config.listenHost, port: config.listenPort });
  console.log(`Web server listening; waiting for the databases…`);
  await waitForEngines((msg) => console.log(msg));
  await detectState();
  const s = appState.state;
  const what = s === 'ready' ? `data ready (${appState.meta?.preset})` : s === 'error' ? `error: ${appState.error?.message}` : s;
  console.log(`Ready → http://localhost:${config.webPort}   (${what})`);
}

// Compose stops containers with SIGTERM. Node as PID 1 ignores it by default, which would
// make every "compose down" wait 10 s for a kill.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
