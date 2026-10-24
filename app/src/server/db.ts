// Connections. Postgres: an admin pool on the "postgres" database (it survives dropping
// "bench"), a pool on "bench" for seeding, and one dedicated read-only client for benchmarks.
// ClickHouse: an admin client and a read-only "reader" client, both over HTTP keep-alive.

import pg from 'pg';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import { config } from './config';

// Dates, timestamps and intervals stay as the text Postgres sends. pg would otherwise turn
// them into JS Dates in the server's local time zone and shift them. Arrays of them become
// arrays of that text.
const RAW_TEXT_OIDS = new Set([1082, 1114, 1184, 1186]);
const RAW_TEXT_ARRAY_OIDS = new Set([1182, 1115, 1185, 1187]);
const TEXT_ARRAY_OID: number = 1009;
// pg only parses arrays of built-in types. Enum arrays (array_agg(status)) would come back as
// the text "{a,b}". Their OIDs change with each load, so they are read on every connect.
const enumArrayOids = new Set<number>();
export const readerTypes = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (RAW_TEXT_OIDS.has(oid)) return (v: string) => v;
    if (RAW_TEXT_ARRAY_OIDS.has(oid) || enumArrayOids.has(oid)) return pg.types.getTypeParser(TEXT_ARRAY_OID, format);
    return pg.types.getTypeParser(oid, format);
  }) as typeof pg.types.getTypeParser,
};

const pgBase = { host: config.pg.host, port: config.pg.port, user: config.pg.user, password: config.pg.password };

export const pgAdmin = new pg.Pool({ ...pgBase, database: 'postgres', max: 2, application_name: 'pg-vs-ch admin' });
pgAdmin.on('error', () => {});

let benchPool: pg.Pool | null = null;

export function pgBench(): pg.Pool {
  if (!benchPool) {
    benchPool = new pg.Pool({ ...pgBase, database: 'bench', max: 3, application_name: 'pg-vs-ch seed' });
    benchPool.on('error', () => {});
  }
  return benchPool;
}

export interface PgReader {
  client: pg.Client;
  pid: number;
}

let reader: Promise<PgReader> | null = null;

// The read-only client that runs every measured Postgres query. Reconnects on demand.
export function pgReader(): Promise<PgReader> {
  if (!reader) {
    const p = (async () => {
      const client = new pg.Client({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.readerUser,
        password: config.pg.readerPassword,
        database: 'bench',
        application_name: 'pg-vs-ch reader',
        types: readerTypes,
      });
      client.on('error', () => {
        if (reader === p) reader = null;
      });
      client.on('end', () => {
        if (reader === p) reader = null;
      });
      await client.connect();
      const { rows } = await client.query<{ pid: number; enum_arrays: number[] }>(
        "SELECT pg_backend_pid() AS pid, ARRAY(SELECT typarray::int FROM pg_type WHERE typtype = 'e' AND typarray <> 0) AS enum_arrays",
      );
      enumArrayOids.clear();
      for (const oid of rows[0].enum_arrays) enumArrayOids.add(oid);
      return { client, pid: rows[0].pid };
    })();
    p.catch(() => {
      if (reader === p) reader = null;
    });
    reader = p;
  }
  return reader;
}

// Called before "bench" is dropped. The next pgBench() / pgReader() call reconnects.
export async function closeBench(): Promise<void> {
  const pool = benchPool;
  const r = reader;
  benchPool = null;
  reader = null;
  await Promise.allSettled([pool?.end(), r?.then((x) => x.client.end())]);
}

// The client's own logger is off: every error also reaches our code, and it would print a
// 20-line block for each refused connection while ClickHouse boots.
const chBase = {
  url: config.ch.url,
  application: 'pg-vs-ch',
  max_open_connections: 4,
  log: { level: ClickHouseLogLevel.OFF },
};

export const chAdmin = createClient({
  ...chBase,
  username: config.ch.user,
  password: config.ch.password,
  // Seeding Large can take minutes; progress headers keep the idle connection alive meanwhile.
  request_timeout: 600_000,
  clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: '10000' },
});

export const chReader = createClient({
  ...chBase,
  username: config.ch.readerUser,
  password: config.ch.readerPassword,
  database: 'bench',
  request_timeout: 60_000,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Compose starts the web container as soon as the databases' containers start, so retry.
export async function waitForEngines(log: (msg: string) => void): Promise<void> {
  const started = Date.now();
  let lastLog = 0;
  for (;;) {
    const [p, c] = await Promise.allSettled([pgAdmin.query('SELECT 1'), chAdmin.query({ query: 'SELECT 1' }).then((r) => r.text())]);
    if (p.status === 'fulfilled' && c.status === 'fulfilled') return;
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      const waiting = [p.status === 'rejected' && 'Postgres', c.status === 'rejected' && 'ClickHouse'].filter(Boolean).join(' and ');
      log(`Waiting for ${waiting} (${Math.round((Date.now() - started) / 1000)} s)…`);
    }
    await sleep(1000);
  }
}
