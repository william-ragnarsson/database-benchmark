// The background jobs that fill and empty both engines, and the boot-time check that decides
// whether existing data is usable. Each job runs detached from the HTTP request that started
// it; the page follows along by polling /api/status.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import type { Engine, EngineProgress, Meta, Preset, PresetId, SeedProgress } from '../../shared/types';
import { bootstrap } from '../bootstrap';
import { chAdmin, closeBench, pgAdmin, pgBench } from '../db';
import { app, setState } from '../state';
import { measureBaseline, warmUp } from '../bench/runner';
import {
  DEFAULT_SEED,
  GENERATOR_VERSION,
  OrderGenerator,
  userChunks,
  userCountries,
  type Chunk,
  type DatasetSpec,
} from './generator';
import { CH_META, CH_TABLES, PG_INDEXES, PG_META, PG_PARALLEL, PG_TABLES, PG_TYPES } from './schema';
import { getSizes, measureSizes, totalBytes } from './sizes';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function newProgress(kind: 'seed' | 'delete', preset: PresetId | null, rowsTotal: number): SeedProgress {
  const engine = (): EngineProgress => ({ step: 'Waiting', rowsDone: 0, rowsTotal, bytesDone: 0, done: false });
  return {
    kind,
    preset,
    phase: 'deleting',
    startedAt: new Date().toISOString(),
    engines: { pg: engine(), ch: engine() },
    etaSec: null,
  };
}

// ---- delete ----

async function deleteAll(progress: SeedProgress): Promise<void> {
  const { pg, ch } = progress.engines;
  pg.step = ch.step = 'Deleting old data';
  // _meta goes first, so a job that dies halfway can never look "ready" on the next boot.
  await Promise.allSettled([
    pgBench().query('DROP TABLE IF EXISTS _meta'),
    chAdmin.command({ query: 'DROP TABLE IF EXISTS bench._meta SYNC' }),
  ]);
  await Promise.all([
    (async () => {
      await closeBench();
      // Dropping the whole database also removes the enum types and any files a crash left behind.
      await pgAdmin.query('DROP DATABASE IF EXISTS bench WITH (FORCE)');
      await pgAdmin.query('CHECKPOINT');
    })(),
    (async () => {
      // Stray reader queries would hold the tables and make the drop wait.
      await chAdmin.command({ query: "KILL QUERY WHERE user = 'reader' SYNC" });
      await chAdmin.command({ query: 'DROP DATABASE IF EXISTS bench SYNC' });
    })(),
  ]);
  await bootstrap();
  pg.step = ch.step = 'Deleted';
}

// ---- load ----

function* tracked(chunks: Iterable<Chunk>, ep: EngineProgress): Generator<string> {
  for (const c of chunks) {
    ep.rowsDone += c.rows;
    ep.bytesDone += c.text.length;
    yield c.text;
  }
}

async function loadPg(spec: DatasetSpec, countries: Uint8Array, ep: EngineProgress): Promise<void> {
  const client = await pgBench().connect();
  let failed: Error | undefined;
  try {
    // One transaction: tables created in it can be loaded with COPY FREEZE, and with
    // wal_level=minimal the load and the index builds write almost no WAL.
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL maintenance_work_mem = '512MB'");
    await client.query('SET LOCAL max_parallel_maintenance_workers = 4');
    for (const sql of [...PG_TYPES, ...PG_TABLES]) await client.query(sql);

    const copy = async (table: string, chunks: Iterable<Chunk>) => {
      // highWaterMark 1: generate one 50k-row chunk per read, so the event loop stays free.
      const source = Readable.from(tracked(chunks, ep), { objectMode: true, highWaterMark: 1 });
      await pipeline(source, client.query(copyFrom(`COPY ${table} FROM STDIN WITH (FREEZE)`)));
    };
    ep.step = 'Loading users';
    await copy('users', userChunks(spec));
    ep.step = 'Loading orders';
    await copy('orders', new OrderGenerator(spec, countries).chunks());

    ep.step = 'Building indexes';
    // parallel_workers first: the index builds use it too.
    for (const sql of [...PG_PARALLEL, ...PG_INDEXES]) await client.query(sql);
    await client.query('COMMIT');

    ep.step = 'VACUUM + ANALYZE';
    await client.query('VACUUM (FREEZE, ANALYZE) users, orders');
    await client.query('CHECKPOINT');
    ep.step = 'Done';
    ep.done = true;
  } catch (err) {
    failed = err as Error;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    // A connection that failed mid-COPY is in an unknown state, so it is thrown away.
    client.release(failed);
  }
}

async function loadCh(spec: DatasetSpec, countries: Uint8Array, ep: EngineProgress): Promise<void> {
  await chAdmin.command({ query: CH_TABLES.users });
  await chAdmin.command({ query: CH_TABLES.orders });
  const insert = (table: string, chunks: Iterable<Chunk>) =>
    chAdmin.insert({
      table: `bench.${table}`,
      // A byte stream, not objectMode: the client passes it through as raw TabSeparated.
      values: Readable.from(tracked(chunks, ep), { objectMode: false }),
      format: 'TabSeparated',
    });
  ep.step = 'Loading users';
  await insert('users', userChunks(spec));
  ep.step = 'Loading orders';
  await insert('orders', new OrderGenerator(spec, countries).chunks());

  // One part per table, so timings don't change as background merges finish.
  ep.step = 'Merging parts (OPTIMIZE FINAL)';
  await chAdmin.command({ query: 'OPTIMIZE TABLE bench.users FINAL' });
  await chAdmin.command({ query: 'OPTIMIZE TABLE bench.orders FINAL' });
  ep.step = 'Done';
  ep.done = true;
}

// ---- verify ----

// Every value is returned as text, so the comparison is exact and engine-independent.
const PG_CHECKS = {
  orders: `SELECT count(*)::text AS n, sum(price_cents)::text AS price, sum(quantity)::text AS qty,
      count(DISTINCT user_id)::text AS buyers, sum(id::int8 * user_id)::text AS id_user,
      sum(id::int8 * price_cents)::text AS id_price,
      sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::text AS completed,
      sum(CASE WHEN payment_method = 'card' THEN 1 ELSE 0 END)::text AS card,
      extract(epoch FROM min(created_at))::bigint::text AS min_ts,
      extract(epoch FROM max(created_at))::bigint::text AS max_ts
    FROM orders`,
  users: `SELECT count(*)::text AS n, sum(birth_year)::text AS birth,
      sum(length(first_name) + length(last_name) + length(email) + length(city))::text AS chars,
      sum(CASE WHEN plan = 'pro' THEN 1 ELSE 0 END)::text AS pro
    FROM users`,
};

const CH_CHECKS = {
  orders: `SELECT toString(count()) AS n, toString(sum(price_cents)) AS price, toString(sum(quantity)) AS qty,
      toString(uniqExact(user_id)) AS buyers, toString(sum(toInt64(id) * user_id)) AS id_user,
      toString(sum(toInt64(id) * price_cents)) AS id_price,
      toString(countIf(status = 'completed')) AS completed,
      toString(countIf(payment_method = 'card')) AS card,
      toString(toUnixTimestamp(min(created_at))) AS min_ts,
      toString(toUnixTimestamp(max(created_at))) AS max_ts
    FROM bench.orders`,
  users: `SELECT toString(count()) AS n, toString(sum(birth_year)) AS birth,
      toString(sum(lengthUTF8(first_name) + lengthUTF8(last_name) + lengthUTF8(email) + lengthUTF8(city))) AS chars,
      toString(countIf(plan = 'pro')) AS pro
    FROM bench.users`,
};

async function chRow(query: string): Promise<Record<string, string>> {
  const rs = await chAdmin.query({ query, format: 'JSONEachRow' });
  const rows = await rs.json<Record<string, string>>();
  return rows[0];
}

async function verify(spec: DatasetSpec): Promise<void> {
  for (const table of ['users', 'orders'] as const) {
    const [pgRes, ch] = await Promise.all([pgBench().query<Record<string, string>>(PG_CHECKS[table]), chRow(CH_CHECKS[table])]);
    const pg = pgRes.rows[0];
    const expected = String(table === 'users' ? spec.users : spec.orders);
    if (pg.n !== expected || ch.n !== expected) {
      throw new Error(`${table}: expected ${expected} rows, Postgres has ${pg.n} and ClickHouse has ${ch.n}`);
    }
    for (const key of Object.keys(pg)) {
      if (pg[key] !== ch[key]) throw new Error(`${table}: checksum "${key}" differs (Postgres ${pg[key]}, ClickHouse ${ch[key]})`);
    }
  }
}

// ---- _meta ----

async function writeMeta(meta: Meta): Promise<void> {
  const data = JSON.stringify(meta);
  await pgBench().query(PG_META);
  await pgBench().query('INSERT INTO _meta (data) VALUES ($1)', [data]);
  await chAdmin.command({ query: CH_META });
  await chAdmin.insert({ table: 'bench._meta', values: [{ data }], format: 'JSONEachRow' });
}

async function readMeta(): Promise<Record<Engine, string | null>> {
  const [pg, ch] = await Promise.allSettled([
    pgBench().query<{ data: string }>('SELECT data FROM _meta'),
    chRow('SELECT data FROM bench._meta'),
  ]);
  return {
    pg: pg.status === 'fulfilled' ? (pg.value.rows[0]?.data ?? null) : null,
    ch: ch.status === 'fulfilled' ? (ch.value?.data ?? null) : null,
  };
}

// ---- jobs ----

let loadStartedAt = 0;

// Time left, from the slower engine's load rate. Unknown while deleting and after loading.
export function updateEta(progress: SeedProgress): void {
  if (progress.phase !== 'loading' || !loadStartedAt) {
    progress.etaSec = null;
    return;
  }
  const elapsed = (Date.now() - loadStartedAt) / 1000;
  const fraction = Math.min(...Object.values(progress.engines).map((e) => e.rowsDone / e.rowsTotal));
  progress.etaSec = fraction > 0.05 ? Math.max(0, Math.round((elapsed * (1 - fraction)) / fraction)) : null;
}

export async function runSeed(preset: Preset): Promise<void> {
  const spec: DatasetSpec = { seed: DEFAULT_SEED, users: preset.users, orders: preset.orders };
  const progress = newProgress('seed', preset.id, spec.users + spec.orders);
  setState('seeding', { progress, error: null, incompleteReason: null, meta: null, baselineMs: null, lastFreedBytes: null });
  try {
    await deleteAll(progress);

    progress.phase = 'loading';
    loadStartedAt = Date.now();
    // Payment methods depend on the buyer's country, so both engines' order generators share this.
    const countries = userCountries(spec);
    const pgLoad = loadPg(spec, countries, progress.engines.pg);
    const chLoad = loadCh(spec, countries, progress.engines.ch);
    const settled = await Promise.allSettled([pgLoad, chLoad]);
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
    loadStartedAt = 0;

    progress.phase = 'verifying';
    progress.engines.pg.step = progress.engines.ch.step = 'Comparing checksums';
    await verify(spec);
    app.baselineMs = await measureBaseline();

    progress.phase = 'warming';
    progress.engines.pg.step = progress.engines.ch.step = 'Warming caches';
    await warmUp();

    const meta: Meta = {
      preset: preset.id,
      seed: spec.seed,
      generatorVersion: GENERATOR_VERSION,
      seededAt: new Date().toISOString(),
      orders: spec.orders,
      users: spec.users,
    };
    await writeMeta(meta);
    progress.phase = 'done';
    setState('ready', { meta, progress: null });
  } catch (err) {
    loadStartedAt = 0;
    setState('error', { progress: null, meta: null, error: { message: message(err), job: 'seed', preset: preset.id } });
  } finally {
    void getSizes(false, true);
  }
}

export async function runDelete(): Promise<void> {
  const progress = newProgress('delete', null, 0);
  setState('deleting', { progress, error: null, lastFreedBytes: null });
  try {
    const before = totalBytes(await measureSizes());
    await deleteAll(progress);
    const after = totalBytes(await getSizes(true, true));
    setState('empty', { progress: null, meta: null, baselineMs: null, incompleteReason: null, lastFreedBytes: Math.max(0, before - after) });
  } catch (err) {
    setState('error', { progress: null, error: { message: message(err), job: 'delete', preset: null } });
  }
}

// ---- boot ----

// Decides between empty / incomplete / ready from what is already on disk.
export async function detectState(): Promise<void> {
  try {
    await bootstrap();
    const [pgObjects, chTables] = await Promise.all([
      pgBench().query<{ n: number }>(
        `SELECT ((SELECT count(*) FROM pg_tables WHERE schemaname = 'public')
               + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typtype = 'e'))::int AS n`,
      ),
      chRow("SELECT toString(count()) AS n FROM system.tables WHERE database = 'bench'"),
    ]);
    if (pgObjects.rows[0].n === 0 && Number(chTables.n) === 0) {
      setState('empty', { meta: null, incompleteReason: null });
      return;
    }

    const raw = await readMeta();
    const incomplete = (reason: string) => setState('incomplete', { meta: null, incompleteReason: reason });
    if (!raw.pg || !raw.ch) return incomplete('The last generation did not finish.');
    if (raw.pg !== raw.ch) return incomplete('The two databases hold different datasets.');
    const meta = JSON.parse(raw.pg) as Meta;
    if (meta.generatorVersion !== GENERATOR_VERSION) return incomplete('This data was made by an older version of the generator.');

    const [pgCounts, chCounts] = await Promise.all([
      pgBench().query<{ users: string; orders: string }>(
        'SELECT (SELECT count(*) FROM users)::text AS users, (SELECT count(*) FROM orders)::text AS orders',
      ),
      chRow('SELECT toString((SELECT count() FROM bench.users)) AS users, toString((SELECT count() FROM bench.orders)) AS orders'),
    ]);
    const want = { users: String(meta.users), orders: String(meta.orders) };
    const pg = pgCounts.rows[0];
    if (pg.users !== want.users || pg.orders !== want.orders || chCounts.users !== want.users || chCounts.orders !== want.orders) {
      return incomplete('The row counts no longer match what was generated.');
    }

    app.baselineMs = await measureBaseline();
    setState('ready', { meta, incompleteReason: null, error: null });
  } catch (err) {
    setState('error', { error: { message: message(err), job: 'boot', preset: null } });
  }
}
