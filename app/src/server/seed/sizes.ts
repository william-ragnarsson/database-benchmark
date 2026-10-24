// The real on-disk size of each engine, as shown in the header's storage bar. "Total"
// equals what the volume holds; "overhead" is everything that isn't the bench tables.

import type { EngineSizes, Sizes } from '../../shared/types';
import { chAdmin, pgAdmin, pgBench } from '../db';

async function pgSizes(): Promise<EngineSizes> {
  const { rows } = await pgAdmin.query<{ db: string; wal: string }>(
    `SELECT (SELECT sum(pg_database_size(oid)) FROM pg_database)::bigint AS db,
            (SELECT coalesce(sum(size), 0) FROM pg_ls_waldir())::bigint AS wal`,
  );
  const totalBytes = Number(rows[0].db) + Number(rows[0].wal);
  const tables: Record<string, number> = {};
  try {
    const res = await pgBench().query<{ name: string; bytes: string }>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    for (const r of res.rows) tables[r.name] = Number(r.bytes);
  } catch {
    // "bench" is being dropped or recreated. The total is still right.
  }
  const benchBytes = Object.values(tables).reduce((a, b) => a + b, 0);
  return { totalBytes, benchBytes, overheadBytes: Math.max(0, totalBytes - benchBytes), tables };
}

async function chSizes(): Promise<EngineSizes> {
  // Inactive parts are counted too: they are on disk until old_parts_lifetime passes.
  const rs = await chAdmin.query({
    query: `SELECT database, table, toString(sum(bytes_on_disk)) AS bytes FROM system.parts GROUP BY database, table`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ database: string; table: string; bytes: string }>();
  let totalBytes = 0;
  const tables: Record<string, number> = {};
  for (const r of rows) {
    const bytes = Number(r.bytes);
    totalBytes += bytes;
    if (r.database === 'bench') tables[r.table] = (tables[r.table] ?? 0) + bytes;
  }
  const benchBytes = Object.values(tables).reduce((a, b) => a + b, 0);
  return { totalBytes, benchBytes, overheadBytes: totalBytes - benchBytes, tables };
}

export async function measureSizes(): Promise<Sizes> {
  const [pg, ch] = await Promise.allSettled([pgSizes(), chSizes()]);
  return {
    pg: pg.status === 'fulfilled' ? pg.value : null,
    ch: ch.status === 'fulfilled' ? ch.value : null,
    measuredAt: new Date().toISOString(),
  };
}

let cached: Sizes | null = null;
let cachedAt = 0;
let inflight: Promise<Sizes> | null = null;

// Cheap enough to call on every /api/status poll: the queries run at most every 2 s while a
// job is running and every 5 s otherwise.
export async function getSizes(busy: boolean, force = false): Promise<Sizes | null> {
  const maxAge = busy ? 2000 : 5000;
  if (!force && cached && Date.now() - cachedAt < maxAge) return cached;
  if (!inflight) {
    inflight = measureSizes()
      .then((s) => {
        cached = s;
        cachedAt = Date.now();
        return s;
      })
      .finally(() => {
        inflight = null;
      });
  }
  try {
    return await inflight;
  } catch {
    return cached;
  }
}

export function totalBytes(s: Sizes | null): number {
  return (s?.pg?.totalBytes ?? 0) + (s?.ch?.totalBytes ?? 0);
}
