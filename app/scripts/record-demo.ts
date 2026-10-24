// Records the static demo from a running stack (docker compose up). Each size is generated,
// then every query runs once with 5 timed runs, as pressing Run on the page does. Events keep
// their real arrival times, so the demo replays them at the pace they happened.
//
//   node scripts/record-demo.ts [http://localhost:8080]
//
// Writes src/client/demo/recordings/*.json, and two files the tests check the demo against:
// test/fixtures/demo-rows.json (pages of real rows, for the in-browser generator) and
// test/fixtures/demo-sql.json (the SQL each query ran). Leaves Standard loaded, whatever the stack held before.

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import type { PresetId, RowsResponse, RunEvent, SeedProgress, Status } from '../src/shared/types';
import type { DemoIndex, DemoPreset, Timed } from '../src/client/demo/format';

const BASE = process.argv[2] ?? 'http://localhost:8080';
const OUT = new URL('../src/client/demo/recordings/', import.meta.url);
const FIXTURE = new URL('../test/fixtures/demo-rows.json', import.meta.url);
const SQL_FIXTURE = new URL('../test/fixtures/demo-sql.json', import.meta.url);
// Light first, so Large and Standard are each generated over another size, with a real delete
// phase. Standard last, so the recorded delete starts from Standard, where the demo starts.
const ORDER: PresetId[] = ['light', 'large', 'standard'];
const POLL_MS = 200;
// ClickHouse removes the parts a merge replaced old_parts_lifetime (10 s) after the merge, on a
// cleanup that runs up to max_cleanup_delay_period (10 s) apart (schema.ts), and the server keeps
// its sizes for 5 s when idle (sizes.ts). Until then its total counts them, and holds still while it does.
const CLEANUP_MS = 30_000;
// Longer than the server keeps its sizes, so each status is measured anew.
const SETTLE_POLL_MS = 6000;
const SETTLE_MAX_MS = 60_000;
const PAGE_SIZE = 20;

interface Template {
  id: string;
  sql: string | { pg: string; ch: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text) as T;
}

const status = () => call<Status>('GET', '/api/status');

// The status once ClickHouse has removed what the last merge replaced: CLEANUP_MS after `since`
// (a performance.now() time), and then once its total holds still between two measures.
async function settledStatus(since: number): Promise<Status> {
  await sleep(Math.max(0, since + CLEANUP_MS - performance.now()));
  let s = await status();
  for (let waited = 0; waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
    await sleep(SETTLE_POLL_MS);
    const next = await status();
    if (next.sizes?.ch?.totalBytes === s.sizes?.ch?.totalBytes) return next;
    s = next;
  }
  log('  ClickHouse sizes still changing; taking the last ones.');
  return s;
}

const sqlOf = (t: Template) => (typeof t.sql === 'string' ? { pg: t.sql, ch: t.sql } : t.sql);

// Progress without its wall-clock start, which the demo sets when it replays.
const strip = (p: SeedProgress): Omit<SeedProgress, 'startedAt'> => {
  const { startedAt: _, ...rest } = p;
  return rest;
};

// Polls until the job leaves `busyState`, keeping each change of progress with its time.
async function follow(busyState: Status['state']): Promise<{ steps: Timed<Omit<SeedProgress, 'startedAt'>>[]; ms: number; end: Status }> {
  const t0 = performance.now();
  const steps: Timed<Omit<SeedProgress, 'startedAt'>>[] = [];
  let last = '';
  for (;;) {
    const s = await status();
    const t = Math.round(performance.now() - t0);
    if (s.state !== busyState) {
      if (s.state === 'error') throw new Error(`The job failed: ${s.error?.message}`);
      return { steps, ms: t, end: s };
    }
    if (s.progress) {
      const p = strip(s.progress);
      const key = JSON.stringify(p);
      if (key !== last) steps.push([t, p]);
      last = key;
    }
    await sleep(POLL_MS);
  }
}

// What the page sees once a job is over. Presets and timestamps are kept elsewhere or redone.
function endStatus(s: Status): DemoPreset['status'] {
  return { sizes: s.sizes, baselineMs: s.baselineMs, meta: s.meta };
}

async function run(t: Template): Promise<Timed<RunEvent>[]> {
  const sql = sqlOf(t);
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sql, runs: 5, templateId: t.id }),
  });
  if (!res.ok || !res.body) throw new Error(`run ${t.id}: ${res.status} ${await res.text()}`);
  const events: Timed<RunEvent>[] = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) events.push([Math.round(performance.now() - t0), JSON.parse(data) as RunEvent]);
    }
  }
  const last = events.at(-1)?.[1];
  if (last?.type !== 'done') throw new Error(`run ${t.id} ended without a result: ${JSON.stringify(last)}`);
  return events;
}

async function pages(meta: NonNullable<Status['meta']>) {
  const out: Record<string, { page: number; rows: unknown[][] }[]> = {};
  for (const [table, total] of [['users', meta.users], ['orders', meta.orders]] as const) {
    const last = Math.ceil(total / PAGE_SIZE);
    // First and last pages, and pages either side of a 50k-row chunk boundary.
    const wanted = [1, 2500, 2501, Math.ceil(last / 2), last];
    out[table] = [];
    for (const page of wanted) {
      const res = await call<RowsResponse>('GET', `/api/dataset/rows?table=${table}&page=${page}&pageSize=${PAGE_SIZE}`);
      out[table].push({ page, rows: res.pg.rows });
    }
  }
  return out;
}

async function main() {
  const first = await status();
  // Any state a Generate can start from: the first one replaces what is there, also data from an
  // older generator ('incomplete') or a failed job ('error').
  if (first.state === 'starting' || first.state === 'seeding' || first.state === 'deleting') {
    throw new Error(`The stack is ${first.state}; wait for it to finish.`);
  }
  const templates = await call<Template[]>('GET', '/api/templates');
  await mkdir(OUT, { recursive: true });
  await mkdir(new URL('.', FIXTURE), { recursive: true });
  const fixture: Record<string, unknown> = {};
  // Written together once everything is recorded, so a run that fails halfway leaves the last recording whole.
  const files: Partial<Record<PresetId, DemoPreset>> = {};

  for (const preset of ORDER) {
    log(`Generating ${preset}…`);
    await call('POST', '/api/dataset', { preset });
    const seed = await follow('seeding');
    const readyAt = performance.now();
    if (seed.end.state !== 'ready' || !seed.end.meta) throw new Error(`Generating ${preset} ended ${seed.end.state}.`);
    log(`  ready in ${(seed.ms / 1000).toFixed(1)} s`);

    const runs: DemoPreset['runs'] = {};
    for (const t of templates) {
      runs[t.id] = await run(t);
      const done = runs[t.id].at(-1)![1] as Extract<RunEvent, { type: 'done' }>;
      const { pg, ch } = done.result.engines;
      log(`  ${t.id}: pg ${pg.medianMs?.toFixed(1)} ms, ch ${ch.medianMs?.toFixed(1)} ms (${done.result.headline.text})`);
    }
    // Once ClickHouse has cleared what its merges replaced. After Standard, the delete starts from here.
    const settled = await settledStatus(readyAt);
    fixture[preset] = { users: seed.end.meta.users, orders: seed.end.meta.orders, pages: await pages(seed.end.meta) };

    files[preset] = { preset, seed: { steps: seed.steps, ms: seed.ms }, status: endStatus(settled), runs };
  }

  log('Deleting…');
  await call('DELETE', '/api/dataset');
  const del = await follow('deleting');
  if (del.end.state !== 'empty') throw new Error(`Deleting ended ${del.end.state}.`);
  const emptySizes = del.end.sizes;

  const cpu = os.cpus();
  const index: DemoIndex = {
    recordedAt: new Date().toISOString(),
    machine: `${cpu[0]?.model ?? 'unknown CPU'}, ${cpu.length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`,
    presets: first.presets,
    delete: { steps: del.steps, ms: del.ms, emptySizes, freedBytes: del.end.lastFreedBytes ?? 0 },
  };
  for (const [preset, file] of Object.entries(files)) await writeFile(new URL(`${preset}.json`, OUT), JSON.stringify(file));
  await writeFile(new URL('index.json', OUT), JSON.stringify(index));
  await writeFile(FIXTURE, JSON.stringify(fixture));
  await writeFile(SQL_FIXTURE, JSON.stringify(Object.fromEntries(templates.map((t) => [t.id, sqlOf(t)])), null, 2) + '\n');
  log('Recorded.');

  log('Generating standard again, to leave Standard loaded…');
  await call('POST', '/api/dataset', { preset: 'standard' });
  await follow('seeding');
  log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
