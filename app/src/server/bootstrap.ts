// Creates the "bench" databases and the Postgres read-only role. Safe to run every time:
// at boot and again after each delete.

import { chAdmin, pgAdmin } from './db';
import { config } from './config';

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

export async function bootstrap(): Promise<void> {
  await ensurePgDatabase();
  await ensurePgReader();
  await chAdmin.command({ query: 'CREATE DATABASE IF NOT EXISTS bench' });
}

export async function ensurePgDatabase(): Promise<void> {
  const { rows } = await pgAdmin.query<{ datconnlimit: number }>("SELECT datconnlimit FROM pg_database WHERE datname = 'bench'");
  // -2 marks a database left invalid by an interrupted DROP DATABASE.
  if (rows.length && rows[0].datconnlimit === -2) await pgAdmin.query('DROP DATABASE bench');
  if (!rows.length || rows[0].datconnlimit === -2) await pgAdmin.query('CREATE DATABASE bench STRATEGY FILE_COPY');
}

async function ensurePgReader(): Promise<void> {
  const role = config.pg.readerUser;
  const statements = [
    `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)}) THEN CREATE ROLE ${role} LOGIN; END IF; END $$`,
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(config.pg.readerPassword)}`,
    `GRANT pg_read_all_data TO ${role}`,
    `ALTER ROLE ${role} SET default_transaction_read_only = on`,
    `ALTER ROLE ${role} SET statement_timeout = '30s'`,
    // Superuser-only setting, so the reader can't raise it. It applies per process.
    `ALTER ROLE ${role} SET temp_file_limit = '100MB'`,
    'REVOKE CONNECT, TEMPORARY ON DATABASE bench FROM PUBLIC',
    'REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC',
    `GRANT CONNECT ON DATABASE bench TO ${role}`,
  ];
  for (const sql of statements) await pgAdmin.query(sql);
}
