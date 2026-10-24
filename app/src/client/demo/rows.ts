// Rows for the demo's data browser, made in the page by the same seeded generator the server
// loads the databases from. It gives byte-identical rows, so no table data has to be shipped.
// test/demo.test.ts checks this against pages read from a real stack.

import { CHUNK_ROWS, OrderGenerator, userChunk, userCountries, type DatasetSpec } from '../../server/seed/generator';
import { TABLES } from '../../shared/schema';
import type { Meta, RowsResponse } from '../../shared/types';

type TableName = (typeof TABLES)[number]['name'];

// Making a chunk takes tens of milliseconds, so the last one per table is kept. Paging stays
// within a chunk for 2,500 pages.
const cache = new Map<TableName, { key: string; lines: string[] }>();
let orders: { key: string; gen: OrderGenerator } | null = null;

const specOf = (meta: Meta): DatasetSpec => ({ seed: meta.seed, users: meta.users, orders: meta.orders });

function chunkLines(table: TableName, spec: DatasetSpec, chunk: number): string[] {
  const key = `${table}:${spec.seed}:${spec.users}:${spec.orders}:${chunk}`;
  const hit = cache.get(table);
  if (hit?.key === key) return hit.lines;
  let text: string;
  if (table === 'users') {
    text = userChunk(spec, chunk).text;
  } else {
    // Payment methods depend on each buyer's country, so orders need every user's first.
    const specKey = `${spec.seed}:${spec.users}:${spec.orders}`;
    if (orders?.key !== specKey) orders = { key: specKey, gen: new OrderGenerator(spec, userCountries(spec)) };
    text = orders.gen.chunk(chunk).text;
  }
  const lines = text.split('\n');
  lines.pop();
  cache.set(table, { key, lines });
  return lines;
}

const unescape = (s: string) =>
  s.includes('\\') ? s.replace(/\\(.)/g, (_, c: string) => (c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c)) : s;

// One TSV line as the server's two drivers return it: Postgres numbers for integer columns
// and "+00" on timestamps, ClickHouse the same without the zone.
function parse(line: string, kinds: string[]): { pg: unknown[]; ch: unknown[] } {
  const pg: unknown[] = [];
  const ch: unknown[] = [];
  line.split('\t').forEach((raw, i) => {
    const v = unescape(raw);
    const kind = kinds[i];
    if (kind.startsWith('int')) {
      pg.push(Number(v));
      ch.push(Number(v));
    } else if (kind === 'timestamptz') {
      pg.push(`${v}+00`);
      ch.push(v);
    } else {
      pg.push(v);
      ch.push(v);
    }
  });
  return { pg, ch };
}

export function readRows(meta: Meta, table: TableName, page: number, pageSize: number): RowsResponse {
  const def = TABLES.find((t) => t.name === table)!;
  const spec = specOf(meta);
  const total = table === 'orders' ? spec.orders : spec.users;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const shown = Math.min(page, pages);
  const from = (shown - 1) * pageSize;
  const to = Math.min(total, from + pageSize);
  const kinds = def.columns.map((c) => c.pg);
  const columns = def.columns.map((c) => c.name);
  const pg: unknown[][] = [];
  const ch: unknown[][] = [];
  for (let i = from; i < to; i++) {
    const row = parse(chunkLines(table, spec, Math.floor(i / CHUNK_ROWS))[i % CHUNK_ROWS], kinds);
    pg.push(row.pg);
    ch.push(row.ch);
  }
  return { table, page: shown, pageSize, total, pages, pg: { columns, rows: pg }, ch: { columns, rows: ch } };
}
