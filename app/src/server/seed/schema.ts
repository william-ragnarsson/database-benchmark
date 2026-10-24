// DDL for both engines, built from the one table description in shared/schema.ts.

import { ENUMS, TABLES, type TableDef } from '../../shared/schema';

const pgEnumLiteral = (v: string) => `'${v.replace(/'/g, "''")}'`;

export const PG_TYPES: string[] = Object.entries(ENUMS).map(
  ([name, values]) => `CREATE TYPE ${name} AS ENUM (${values.map(pgEnumLiteral).join(', ')})`,
);

// Indexes are added after the COPY. Building them once is much faster than updating them per row.
function pgTable(t: TableDef): string {
  return `CREATE TABLE ${t.name} (\n${t.columns.map((c) => `  ${c.name} ${c.pg} NOT NULL`).join(',\n')}\n)`;
}

export const PG_TABLES: string[] = TABLES.map(pgTable);

export const PG_INDEXES: string[] = [
  'ALTER TABLE users ADD PRIMARY KEY (id)',
  'ALTER TABLE orders ADD PRIMARY KEY (id)',
  'CREATE INDEX orders_user_id_idx ON orders (user_id)',
  'CREATE INDEX orders_created_at_brin ON orders USING brin (created_at)',
];

// Postgres sizes its worker count from the table size and would use only 1–2 workers at
// Light and Standard. ClickHouse always gets max_threads = 4, so give Postgres its leader + 3.
export const PG_PARALLEL: string[] = TABLES.map((t) => `ALTER TABLE ${t.name} SET (parallel_workers = 3)`);

export const PG_META = 'CREATE TABLE _meta (data text NOT NULL)';

function chTable(t: TableDef): string {
  const cols = t.columns.map((c) => `  ${c.name} ${c.ch}${c.chCodec ? ` ${c.chCodec}` : ''}`).join(',\n');
  // Parts replaced by OPTIMIZE are deleted within ~20 s instead of 8 minutes, so the disk use
  // drops soon after a load. The cleanup thread otherwise backs off to every 5 minutes when idle.
  const settings = 'old_parts_lifetime = 10, cleanup_delay_period = 5, max_cleanup_delay_period = 10, cleanup_delay_period_random_add = 0';
  return `CREATE TABLE bench.${t.name} (\n${cols}\n) ENGINE = MergeTree ORDER BY ${t.chOrderBy} SETTINGS ${settings}`;
}

export const CH_TABLES: Record<TableDef['name'], string> = Object.fromEntries(TABLES.map((t) => [t.name, chTable(t)])) as Record<
  TableDef['name'],
  string
>;

export const CH_META = 'CREATE TABLE bench._meta (data String) ENGINE = TinyLog';
