// Runs a query on both engines and times it. Each engine has one read-only connection; the
// engines never run at the same time. Order: one warm-up per engine (not counted), then up
// to 5 measured runs alternating PG CH CH PG PG CH…

import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ClickHouseError } from '@clickhouse/client';
import { chAdmin, chReader, pgAdmin, pgBench, pgReader } from '../db';
import { TEMPLATES, templateSql } from '../../shared/templates';
import type {
  ChStats,
  Engine,
  EngineResult,
  EngineStatus,
  ExplainResponse,
  Headline,
  RunEvent,
  RunResult,
  SuiteEvent,
  SuiteItem,
  SuiteSummary,
} from '../../shared/types';
import { GuardError, SHOWN_ROWS, WRAP_PREFIX, looksAggregating, prepare, wrap, type Prepared } from './guard';
import { cleanChError, compareResults, errorHint } from './compare';
import { ENGINE_NAMES, geomean, headline, median, speedText } from './stats';

export const ENGINES: Engine[] = ['pg', 'ch'];
export const TIMEOUT_MS = 30_000;
// A warm-up slower than this gets a single measured run.
const SLOW_MS = 1_000;
// No new run starts once a click has been going for this long, except each engine's first
// measured run: a median always comes from measured runs, never from the warm-up.
const BUDGET_MS = 60_000;
// Both engines stop a query themselves at 30 s. This client-side cancel is only a backstop.
const BACKSTOP_MS = TIMEOUT_MS + 2_000;
const MAX_SQL_CHARS = 20_000;

interface Exec {
  status: EngineStatus;
  ms: number;
  columns: string[];
  types: string[];
  rows: unknown[][];
  error: string | null;
  chStats: ChStats | null;
}

const elapsedMs = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;

const failed = (status: EngineStatus, ms: number, error: string): Exec => ({
  status,
  ms,
  columns: [],
  types: [],
  rows: [],
  error,
  chStats: null,
});

// ---- Postgres ----

const PG_TYPE_NAMES = new Map<number, string>([
  [16, 'boolean'], [18, 'char'], [19, 'name'], [20, 'bigint'], [21, 'smallint'], [23, 'integer'], [25, 'text'],
  [26, 'oid'], [114, 'json'], [700, 'real'], [701, 'double precision'], [1043, 'varchar'], [1082, 'date'],
  [1114, 'timestamp'], [1184, 'timestamptz'], [1186, 'interval'], [1700, 'numeric'], [2950, 'uuid'], [3802, 'jsonb'],
]);

// Enum and array types have OIDs that change with each load, so look them up when first seen.
async function pgTypeNames(oids: number[]): Promise<string[]> {
  const missing = [...new Set(oids)].filter((o) => !PG_TYPE_NAMES.has(o));
  if (missing.length) {
    try {
      const { rows } = await pgBench().query<{ oid: number; name: string }>(
        'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
        [missing],
      );
      for (const r of rows) PG_TYPE_NAMES.set(r.oid, r.name);
    } catch {
      // Only the type labels are missing.
    }
  }
  return oids.map((o) => PG_TYPE_NAMES.get(o) ?? `oid ${o}`);
}

function pgErrorText(err: pg.DatabaseError, offset: number): string {
  let text = err.message;
  const pos = Number(err.position);
  if (pos > offset) text += ` (at character ${pos - offset})`;
  if (err.hint) text += `\nHint: ${err.hint}`;
  return text;
}

async function execPg(sql: string, signal: AbortSignal, offset: number): Promise<Exec> {
  let reader: Awaited<ReturnType<typeof pgReader>>;
  try {
    reader = await pgReader();
    // Outside the timing: a set_config(…) in an earlier query must not carry over.
    await reader.client.query('RESET ALL');
  } catch (e) {
    return failed('error', 0, `Could not reach Postgres: ${(e as Error).message}`);
  }
  const { client, pid } = reader;
  let timedOut = false;
  const cancel = () => void pgAdmin.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {});
  const backstop = setTimeout(() => {
    timedOut = true;
    cancel();
  }, BACKSTOP_MS);
  signal.addEventListener('abort', cancel, { once: true });
  const t0 = process.hrtime.bigint();
  try {
    // Extended protocol: an unnamed statement, planned fresh each time, one statement only.
    const res = (await client.query({ text: sql, rowMode: 'array', queryMode: 'extended' } as pg.QueryArrayConfig)) as pg.QueryArrayResult;
    const ms = elapsedMs(t0);
    return {
      status: 'ok',
      ms,
      columns: res.fields.map((f) => f.name),
      types: await pgTypeNames(res.fields.map((f) => f.dataTypeID)),
      rows: res.rows,
      error: null,
      chStats: null,
    };
  } catch (e) {
    const ms = elapsedMs(t0);
    const err = e as pg.DatabaseError;
    if (signal.aborted) return failed('cancelled', ms, 'Cancelled');
    if (timedOut || err.code === '57014') return failed('timeout', ms, 'Timed out after 30 s');
    return failed('error', ms, err.code ? pgErrorText(err, offset) : `Postgres connection error: ${err.message}`);
  } finally {
    clearTimeout(backstop);
    signal.removeEventListener('abort', cancel);
  }
}

// ---- ClickHouse ----

function chStats(headers: Record<string, string | string[] | undefined>): ChStats {
  const raw = headers['x-clickhouse-summary'];
  try {
    const s = JSON.parse((Array.isArray(raw) ? raw[0] : raw) ?? '{}') as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v == null ? null : Number(v));
    return { elapsedMs: s.elapsed_ns == null ? null : Number(s.elapsed_ns) / 1e6, rowsRead: num(s.read_rows), bytesRead: num(s.read_bytes) };
  } catch {
    return { elapsedMs: null, rowsRead: null, bytesRead: null };
  }
}

async function execCh(sql: string, signal: AbortSignal): Promise<Exec> {
  const queryId = randomUUID();
  const abort = new AbortController();
  let timedOut = false;
  const kill = () => {
    abort.abort();
    void chAdmin.command({ query: 'KILL QUERY WHERE query_id = {id:String} ASYNC', query_params: { id: queryId } }).catch(() => {});
  };
  const backstop = setTimeout(() => {
    timedOut = true;
    kill();
  }, BACKSTOP_MS);
  signal.addEventListener('abort', kill, { once: true });
  const t0 = process.hrtime.bigint();
  try {
    // Every other setting comes from the reader profile, where the fairness ones are locked.
    const rs = await chReader.query({
      query: sql,
      format: 'JSONCompactEachRowWithNamesAndTypes',
      query_id: queryId,
      abort_signal: abort.signal,
      clickhouse_settings: { wait_end_of_query: 1, cancel_http_readonly_queries_on_client_close: 1 },
    });
    const [names = [], types = [], ...rows] = (await rs.json()) as unknown[][];
    const ms = elapsedMs(t0);
    return {
      status: 'ok',
      ms,
      columns: names as string[],
      types: types as string[],
      rows,
      error: null,
      chStats: chStats(rs.response_headers),
    };
  } catch (e) {
    const ms = elapsedMs(t0);
    const err = e as ClickHouseError;
    if (signal.aborted) return failed('cancelled', ms, 'Cancelled');
    if (timedOut || err.code === '159') return failed('timeout', ms, 'Timed out after 30 s');
    return failed('error', ms, err.code ? cleanChError(err.message) : `ClickHouse connection error: ${err.message}`);
  } finally {
    clearTimeout(backstop);
    signal.removeEventListener('abort', kill);
  }
}

function exec(engine: Engine, sql: string, signal: AbortSignal, offset = WRAP_PREFIX.length): Promise<Exec> {
  return engine === 'pg' ? execPg(sql, signal, offset) : execCh(sql, signal);
}

const NEVER = new AbortController().signal;

// ---- Cancelling ----

const active = new Map<string, AbortController>();

export function registerRun(): { runId: string; signal: AbortSignal; finish: () => void } {
  const runId = randomUUID();
  const controller = new AbortController();
  active.set(runId, controller);
  return { runId, signal: controller.signal, finish: () => active.delete(runId) };
}

export function cancelRun(runId: string): boolean {
  const c = active.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

// ---- Fixed cost and warm-up ----

// The round-trip cost of a trivial query on each connection, shown as "fixed cost per query".
export async function measureBaseline(): Promise<Record<Engine, number>> {
  const times: Record<Engine, number[]> = { pg: [], ch: [] };
  for (let i = 0; i < 6; i++) {
    for (const engine of i % 2 ? (['ch', 'pg'] as const) : (['pg', 'ch'] as const)) {
      const r = await exec(engine, 'SELECT 1', NEVER);
      if (r.status !== 'ok') throw new Error(`${ENGINE_NAMES[engine]} reader: ${r.error}`);
      if (i > 0) times[engine].push(r.ms);
    }
  }
  return { pg: median(times.pg)!, ch: median(times.ch)! };
}

// Runs every template once so the first click finds the data in RAM.
export async function warmUp(): Promise<void> {
  for (const t of TEMPLATES) {
    const sql = templateSql(t);
    for (const engine of ENGINES) await exec(engine, wrap(sql[engine]), NEVER);
  }
}

// ---- One click ----

export interface RunInput {
  pg: Prepared;
  ch: Prepared;
  raw: Record<Engine, string>;
  runs: 1 | 3 | 5;
  templateId: string | null;
}

// Validates a request body. Throws GuardError with a message for the page.
export function prepareRun(body: unknown): RunInput {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.pg !== 'string' || typeof b.ch !== 'string') throw new GuardError('Both "pg" and "ch" SQL are required.');
  if (b.pg.length > MAX_SQL_CHARS || b.ch.length > MAX_SQL_CHARS) throw new GuardError('The query is too long.');
  const runs = b.runs === undefined ? 5 : b.runs;
  if (runs !== 1 && runs !== 3 && runs !== 5) throw new GuardError('"runs" must be 1, 3 or 5.');
  const templateId = typeof b.templateId === 'string' && TEMPLATES.some((t) => t.id === b.templateId) ? b.templateId : null;
  const same = b.pg === b.ch;
  const prep = (engine: Engine, sql: string) => {
    try {
      return prepare(sql, engine);
    } catch (e) {
      if (e instanceof GuardError && !same) throw new GuardError(`${ENGINE_NAMES[engine]} SQL: ${e.message}`);
      throw e;
    }
  };
  return { pg: prep('pg', b.pg), ch: prep('ch', b.ch), raw: { pg: b.pg, ch: b.ch }, runs, templateId };
}

interface Lane {
  status: EngineStatus;
  warmupMs: number | null;
  runsMs: number[];
  target: number;
  last: Exec | null;
  error: string | null;
}

function toResult(engine: Engine, lane: Lane, raw: string): EngineResult {
  const last = lane.last;
  const rows = last?.rows ?? [];
  const ok = lane.status === 'ok';
  return {
    status: lane.status,
    warmupMs: lane.warmupMs,
    runsMs: lane.runsMs,
    medianMs: ok ? median(lane.runsMs) : null,
    slow: ok && lane.target === 1 && (lane.warmupMs ?? 0) > SLOW_MS,
    columns: last?.columns ?? [],
    types: last?.types ?? [],
    rows: rows.slice(0, SHOWN_ROWS),
    truncated: rows.length > SHOWN_ROWS,
    error: lane.error,
    hint: lane.status === 'error' && lane.error ? errorHint(engine, lane.error, raw) : null,
    chStats: last?.chStats ?? null,
  };
}

const CANCELLED: Headline = { text: 'Cancelled', winner: null, ratio: null, lowerBound: false, instant: false };

export async function runPair(input: RunInput, emit: (e: RunEvent) => void, signal: AbortSignal, runId: string): Promise<RunResult> {
  const started = Date.now();
  const sql = { pg: wrap(input.pg.sql), ch: wrap(input.ch.sql) };
  const lanes: Record<Engine, Lane> = {
    pg: { status: 'ok', warmupMs: null, runsMs: [], target: input.runs, last: null, error: null },
    ch: { status: 'ok', warmupMs: null, runsMs: [], target: input.runs, last: null, error: null },
  };
  emit({ type: 'start', runId, runs: input.runs });

  for (const engine of ENGINES) {
    const lane = lanes[engine];
    if (signal.aborted) {
      lane.status = 'cancelled';
      continue;
    }
    const r = await exec(engine, sql[engine], signal);
    lane.status = r.status;
    lane.warmupMs = r.ms;
    lane.error = r.error;
    if (r.status === 'ok') lane.last = r;
    if (r.status === 'ok' && r.ms > SLOW_MS) lane.target = 1;
    emit({ type: 'warmup', engine, ms: r.ms, status: r.status, runs: r.status === 'ok' ? lane.target : 0 });
  }

  measured: for (let i = 0; i < input.runs; i++) {
    for (const engine of i % 2 === 0 ? (['pg', 'ch'] as const) : (['ch', 'pg'] as const)) {
      const lane = lanes[engine];
      if (lane.status !== 'ok' || lane.runsMs.length >= lane.target) continue;
      if (signal.aborted) break measured;
      if (Date.now() - started > BUDGET_MS && ENGINES.every((e) => lanes[e].status !== 'ok' || lanes[e].runsMs.length > 0)) {
        break measured;
      }
      const r = await exec(engine, sql[engine], signal);
      if (r.status !== 'ok') {
        // A failure after a good warm-up (a cancel, or a rare timeout): keep the runs so far.
        if (r.status !== 'cancelled' && !lane.runsMs.length) {
          lane.status = r.status;
          lane.error = r.error;
        }
        lane.target = lane.runsMs.length;
        continue;
      }
      lane.last = r;
      lane.runsMs.push(r.ms);
      emit({ type: 'run', engine, index: lane.runsMs.length - 1, ms: r.ms });
    }
  }

  // Only a cancel can leave a good lane without a measured run.
  for (const engine of ENGINES) if (lanes[engine].status === 'ok' && !lanes[engine].runsMs.length) lanes[engine].status = 'cancelled';

  const engines = { pg: toResult('pg', lanes.pg, input.raw.pg), ch: toResult('ch', lanes.ch, input.raw.ch) };
  const bothOk = engines.pg.status === 'ok' && engines.ch.status === 'ok';
  const match = bothOk
    ? compareResults(
        { ...engines.pg, rows: lanes.pg.last?.rows ?? [] },
        { ...engines.ch, rows: lanes.ch.last?.rows ?? [] },
        { pg: input.pg, ch: input.ch, raw: input.raw.pg === input.raw.ch ? input.raw.pg : `${input.raw.pg}\n${input.raw.ch}` },
      )
    : { kind: 'not-compared' as const, detail: null, hint: null };
  const truncated = engines.pg.truncated || engines.ch.truncated;
  return {
    runId,
    templateId: input.templateId,
    engines,
    headline: signal.aborted ? CANCELLED : headline(engines.pg, engines.ch),
    match,
    truncationHint: truncated && !looksAggregating(input.pg) && !looksAggregating(input.ch),
    totalMs: Date.now() - started,
  };
}

// ---- The full suite ----

export async function runSuite(runs: 1 | 3 | 5, emit: (e: SuiteEvent) => void, signal: AbortSignal, runId: string): Promise<void> {
  emit({ type: 'start', runId, total: TEMPLATES.length });
  const items: SuiteItem[] = [];
  for (const [index, t] of TEMPLATES.entries()) {
    if (signal.aborted) break;
    emit({ type: 'template-start', templateId: t.id, index });
    const sql = templateSql(t);
    const input: RunInput = { pg: prepare(sql.pg, 'pg'), ch: prepare(sql.ch, 'ch'), raw: sql, runs, templateId: t.id };
    const r = await runPair(input, () => {}, signal, runId);
    if (signal.aborted) break;
    const item: SuiteItem = {
      templateId: t.id,
      title: t.title,
      expectedWinner: t.expectedWinner,
      pgMs: r.engines.pg.medianMs,
      chMs: r.engines.ch.medianMs,
      headline: r.headline,
      match: r.match.kind,
      failed: r.engines.pg.status !== 'ok' || r.engines.ch.status !== 'ok',
    };
    items.push(item);
    emit({ type: 'template-done', item, index });
  }
  emit({ type: 'done', items, summary: summarise(items, signal.aborted) });
}

export function summarise(items: SuiteItem[], cancelled = false): SuiteSummary {
  const ok = items.filter((i) => !i.failed && i.pgMs != null && i.chMs != null);
  const geo = geomean(ok.map((i) => i.pgMs! / Math.max(i.chMs!, 0.001)));
  const s = geo == null ? { text: 'No results', winner: null } : speedText(geo, ' overall');
  return {
    geomeanRatio: geo,
    winner: s.winner,
    text: cancelled ? `Cancelled after ${items.length} of ${TEMPLATES.length}` : s.text,
    pgTotalMs: ok.reduce((a, i) => a + i.pgMs!, 0),
    chTotalMs: ok.reduce((a, i) => a + i.chMs!, 0),
    failed: items.filter((i) => i.failed).map((i) => i.templateId),
  };
}

// ---- Explain ----

const EXPLAIN_PREFIX: Record<Engine, string> = { pg: 'EXPLAIN (ANALYZE, BUFFERS) ', ch: 'EXPLAIN indexes = 1 ' };

// Runs without the LIMIT wrapper, so the plan is the plan of the query as written.
export async function explain(engine: Engine, sql: string, signal: AbortSignal): Promise<ExplainResponse> {
  const p = prepare(sql, engine);
  const r = await exec(engine, EXPLAIN_PREFIX[engine] + p.sql, signal, EXPLAIN_PREFIX[engine].length);
  if (r.status !== 'ok') return { engine, plan: '', error: r.error };
  return { engine, plan: r.rows.map((row) => String(row[0])).join('\n'), error: null };
}
