import { fmtMs, fmtRatio } from './format';
import { TABLES } from '../shared/schema';
import type { Engine, Meta, PresetId, RunResult } from '../shared/types';

// The Run page draws a few example rows of the query's table and lights each cell as an engine
// reads it: Postgres row by row, ClickHouse column by column. Each scene says which rows and
// columns each engine reads, read off the real EXPLAIN plans.

export type TableName = 'orders' | 'users';

type Row = Record<string, string>;

const COLUMNS = Object.fromEntries(TABLES.map((t) => [t.name, t.columns.map((c) => c.name)])) as Record<
  TableName,
  string[]
>;

const sample = (table: TableName, rows: string[][]): Row[] =>
  rows.map((values) => Object.fromEntries(COLUMNS[table].map((name, i) => [name, values[i]])));

// Rows from the seeded data, in id order; orders are also in time order. Picked so each scene
// has rows on both sides of its filter. The users are the same at every size; the orders aren't.
export const SAMPLE_ROWS: { orders: Record<PresetId, Row[]>; users: Row[] } = {
  orders: {
    light: sample('orders', [
      ['1', '21283', '2024-01-01 00:03:38', 'beauty', '3', '999', 'completed', 'paypal'],
      ['35827', '4242', '2024-05-25 19:56:25', 'beauty', '1', '3599', 'completed', 'card'],
      ['124880', '31113', '2025-02-20 00:38:30', 'toys', '1', '8699', 'cancelled', 'card'],
      ['126964', '4242', '2025-02-27 15:53:45', 'home', '1', '4399', 'completed', 'card'],
      ['127694', '42211', '2025-03-02 00:12:40', 'clothing', '1', '16199', 'completed', 'card'],
      ['147759', '25452', '2025-05-01 00:00:36', 'electronics', '2', '5699', 'completed', 'card'],
      ['242424', '48363', '2025-12-18 15:16:47', 'electronics', '2', '15199', 'pending', 'apple_pay'],
      ['250000', '21089', '2025-12-31 23:57:44', 'home', '4', '5899', 'shipped', 'card'],
    ]),
    standard: sample('orders', [
      ['1', '42565', '2024-01-01 00:00:54', 'beauty', '3', '999', 'completed', 'card'],
      ['242424', '96725', '2024-08-21 14:44:23', 'electronics', '2', '15199', 'completed', 'apple_pay'],
      ['242741', '4242', '2024-08-21 19:17:47', 'garden', '1', '15099', 'completed', 'bank_transfer'],
      ['500000', '94762', '2025-02-20 14:11:26', 'beauty', '1', '2799', 'cancelled', 'card'],
      ['511000', '82018', '2025-03-02 09:23:31', 'toys', '1', '4799', 'completed', 'card'],
      ['592000', '11319', '2025-05-01 19:48:09', 'books', '1', '2399', 'completed', 'card'],
      ['683617', '4242', '2025-07-03 21:30:22', 'clothing', '1', '18499', 'completed', 'paypal'],
      ['999999', '40533', '2025-12-31 23:58:10', 'clothing', '1', '2199', 'shipped', 'card'],
    ]),
    large: sample('orders', [
      ['1', '133400', '2024-01-01 00:00:10', 'beauty', '3', '999', 'completed', 'card'],
      ['242424', '193449', '2024-02-25 20:23:29', 'electronics', '2', '15199', 'completed', 'bank_transfer'],
      ['2133673', '4242', '2024-12-23 11:46:25', 'toys', '1', '7199', 'completed', 'card'],
      ['2497532', '181195', '2025-02-20 00:04:51', 'books', '1', '2299', 'cancelled', 'card'],
      ['2553847', '54638', '2025-03-02 00:00:18', 'home', '1', '37799', 'completed', 'card'],
      ['2955157', '106953', '2025-05-01 00:00:18', 'clothing', '2', '9499', 'completed', 'paypal'],
      ['4999379', '4242', '2025-12-31 22:25:26', 'sports', '1', '1699', 'shipped', 'gift_card'],
      ['5000000', '89363', '2025-12-31 23:59:56', 'clothing', '1', '3099', 'shipped', 'card'],
    ]),
  },
  users: sample('users', [
    ['7', 'Pablo', 'Gray', 'pablo.gray@mail.com', 'Australia', 'Perth', '2021-09-05', '1977', 'free'],
    ['19', 'Amanda', 'Joshi', 'amanda.joshi5593@gmail.com', 'Germany', 'Berlin', '2021-11-05', '1967', 'team'],
    ['26', 'Melissa', 'Larsson', 'melissa.larsson@gmail.com', 'France', 'Lyon', '2024-03-23', '1985', 'free'],
    ['31', 'Deborah', 'Gray', 'deborah.gray1391@gmx.de', 'United States', 'San Jose', '2024-09-11', '1989', 'pro'],
    ['99', 'Ryan', 'Henderson', 'ryan.henderson52@gmail.com', 'United States', 'San Diego', '2025-03-17', '1981', 'pro'],
    ['118', 'David', 'Johnson', 'david.johnson6006@outlook.com', 'Brazil', 'Santos', '2023-03-16', '1995', 'free'],
  ]),
};

// ILIKE 'text%' (start) or '%text%'.
interface Term {
  column: string;
  text: string;
  start: boolean;
}

type Scene = {
  table: TableName;
  // The columns drawn on a narrow card, and on a wide one (all of them by default). The rest
  // fold into one "+N" column at the end.
  narrow: string[];
  wide?: string[];
  note?: string;
} & (
  // A full scan: Postgres reads whole rows, ClickHouse only its columns, in this order. keep is
  // a WHERE on the first of them, which ClickHouse reads first (PREWHERE).
  | { kind: 'scan'; read: string[]; keep?: { column: string; value: string } }
  // A created_at range both engines skip to, from (inclusive) to (exclusive).
  | { kind: 'range'; read: string[]; from: string; to: string; label: string }
  // A point lookup: Postgres's index finds the rows; ClickHouse scans the key column, then
  // reads the other columns of the matches.
  | { kind: 'lookup'; key: string; value: string; out: string[] }
  // users, ORDER BY id LIMIT: both walk ids in order until they have enough matches. Postgres
  // reads whole rows; ClickHouse reads its columns, then the out columns of the matches.
  | { kind: 'search'; read: string[]; out: string[]; terms: Term[]; limit: number }
);

const NOT_DRAWN_JOIN = 'Not drawn: both also match each order to its user.';
const COMPLETED = { column: 'status', value: 'completed' };

export const SCENES: Record<string, Scene> = {
  'revenue-by-category': {
    kind: 'scan',
    table: 'orders',
    read: ['status', 'category', 'quantity', 'price_cents'],
    keep: COMPLETED,
    narrow: ['category', 'quantity', 'price_cents', 'status'],
  },
  'busiest-customer-days': {
    kind: 'scan',
    table: 'orders',
    read: ['user_id', 'created_at'],
    narrow: ['user_id', 'created_at', 'category'],
    note: 'Not drawn: ClickHouse also groups the orders by customer and day faster.',
  },
  'users-by-signup-year': {
    kind: 'scan',
    table: 'users',
    read: ['signup_date', 'birth_year', 'plan'],
    narrow: ['id', 'first_name', 'signup_date', 'birth_year', 'plan'],
    wide: ['id', 'first_name', 'email', 'country', 'signup_date', 'birth_year', 'plan'],
  },
  'daily-orders': {
    kind: 'range',
    table: 'orders',
    read: ['created_at', 'quantity', 'price_cents'],
    from: '2025-03-01',
    to: '2025-06-01',
    label: 'Mar–May 2025',
    narrow: ['id', 'created_at', 'quantity', 'price_cents'],
  },
  'running-monthly-revenue': {
    kind: 'scan',
    table: 'orders',
    read: ['created_at', 'quantity', 'price_cents'],
    narrow: ['id', 'created_at', 'quantity', 'price_cents'],
  },
  'distinct-buyers-per-month': {
    kind: 'range',
    table: 'orders',
    read: ['user_id', 'created_at'],
    from: '2025-01-01',
    to: '2026-01-01',
    label: '2025',
    narrow: ['id', 'user_id', 'created_at', 'status'],
    note: 'Not drawn: to count distinct buyers, Postgres sorts the 2025 orders; ClickHouse uses hash sets.',
  },
  'price-percentiles': {
    kind: 'scan',
    table: 'orders',
    read: ['category', 'price_cents'],
    narrow: ['id', 'category', 'price_cents', 'status'],
    note: 'Not drawn: Postgres then sorts each category’s prices in one process.',
  },
  'revenue-by-country': {
    kind: 'scan',
    table: 'orders',
    read: ['user_id', 'quantity', 'price_cents'],
    narrow: ['id', 'user_id', 'category', 'quantity', 'price_cents'],
    note: NOT_DRAWN_JOIN,
  },
  'top-customers': {
    kind: 'scan',
    table: 'orders',
    read: ['status', 'user_id', 'quantity', 'price_cents'],
    keep: COMPLETED,
    narrow: ['id', 'user_id', 'quantity', 'price_cents', 'status'],
    note: 'Not drawn: Postgres then looks up the top 10 users by id; ClickHouse reads the users table to join them.',
  },
  'card-share-by-country': {
    kind: 'scan',
    table: 'orders',
    read: ['user_id', 'payment_method'],
    narrow: ['id', 'user_id', 'category', 'payment_method'],
    note: NOT_DRAWN_JOIN,
  },
  'email-city-search': {
    kind: 'search',
    table: 'users',
    read: ['email', 'city', 'id'],
    out: ['first_name', 'last_name'],
    terms: [
      { column: 'email', text: 'son', start: false },
      { column: 'city', text: 'san', start: true },
    ],
    limit: 50,
    narrow: ['id', 'email', 'city'],
    wide: ['id', 'first_name', 'last_name', 'email', 'country', 'city', 'plan'],
  },
  'order-by-id': {
    kind: 'lookup',
    table: 'orders',
    key: 'id',
    value: '242424',
    out: ['user_id', 'created_at', 'category', 'quantity', 'price_cents', 'status', 'payment_method'],
    narrow: ['id', 'user_id', 'category', 'price_cents', 'status'],
  },
  'customer-last-orders': {
    kind: 'lookup',
    table: 'orders',
    key: 'user_id',
    value: '4242',
    out: ['id', 'created_at', 'category', 'quantity', 'price_cents', 'status'],
    narrow: ['id', 'user_id', 'created_at', 'price_cents'],
  },
};

export interface Column {
  name: string;
  // The query needs it (for "+N": one of the folded columns).
  used: boolean;
  // In characters, for sharing out the width.
  width: number;
  // "+N" only: the columns folded into it.
  more?: string[];
}

export interface Value {
  text: string;
  // The part a search term matched, [from, to).
  mark?: [number, number];
}

// A cell lights at `at`; if the query needs it, it turns darker at `hit` (≥ at), once the
// engine knows the row passes.
export interface Cell {
  r: number;
  c: number;
  at: number;
  hit: number | null;
}

export interface Side {
  cells: Cell[];
  // Rows this engine never touches, faded once it's done.
  skipped: number[];
  // How long the drawing takes, and how much of it is the engine starting up.
  d: number;
  wait: number;
  caption: string;
}

export interface Plan {
  table: TableName;
  columns: Column[];
  rows: Value[][];
  pg: Side;
  ch: Side;
  // The faster engine's drawing is held at a minimum length, so the real gap can be wider.
  note: string | null;
}

// The slower engine takes this long to draw; the faster one takes its share of it.
export const SLOW_MS = 3000;
export const MIN_MS = 400;
// A pause before the first cell, so a new loop reads as a new start.
export const LEAD_MS = 300;
// Each engine's fixed cost per query when the status doesn't have one yet.
const FALLBACK_BASELINE: Record<Engine, number> = { pg: 0.3, ch: 3 };

function matchTerm(term: Term, value: string): [number, number] | null {
  const lower = value.toLowerCase();
  const i = term.start ? (lower.startsWith(term.text) ? 0 : -1) : lower.indexOf(term.text);
  return i < 0 ? null : [i, i + term.text.length];
}

function passes(scene: Scene, row: Row): boolean {
  switch (scene.kind) {
    case 'scan':
      return !scene.keep || row[scene.keep.column] === scene.keep.value;
    case 'range':
      return row.created_at >= scene.from && row.created_at < scene.to;
    case 'lookup':
      return row[scene.key] === scene.value;
    case 'search':
      return scene.terms.every((t) => matchTerm(t, row[t.column]) !== null);
  }
}

function usedColumns(scene: Scene): string[] {
  switch (scene.kind) {
    case 'scan':
    case 'range':
      return scene.read;
    case 'lookup':
      return [scene.key, ...scene.out];
    case 'search':
      return [...scene.read, ...scene.out];
  }
}

// The columns each engine has to read to know whether a row passes. Postgres's index answers
// a lookup, and a range is skipped to, not checked row by row.
function filterColumns(scene: Scene): Record<Engine, string[]> {
  switch (scene.kind) {
    case 'scan': {
      const keep = scene.keep ? [scene.keep.column] : [];
      return { pg: keep, ch: keep };
    }
    case 'range':
      return { pg: [], ch: [] };
    case 'lookup':
      return { pg: [], ch: [scene.key] };
    case 'search': {
      const terms = scene.terms.map((t) => t.column);
      return { pg: terms, ch: terms };
    }
  }
}

// Every column the drawing has to show on its own, so its filtering can be seen.
export function requiredColumns(scene: Scene): string[] {
  const { pg, ch } = filterColumns(scene);
  const read = scene.kind === 'lookup' ? [scene.key] : scene.read;
  return [...new Set([...read, ...pg, ...ch])];
}

type Step = { r: number; c: number }[];

// Spreads the steps over the drawing, after the engine's start-up wait. A cell already lit by
// an earlier step stays as it was.
function timed(steps: Step[], d: number, wait: number): Omit<Cell, 'hit'>[] {
  const each = (d - wait) / Math.max(1, steps.length);
  const seen = new Set<string>();
  return steps.flatMap((step, i) =>
    step
      .filter(({ r, c }) => {
        const key = `${r}-${c}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((cell) => ({ ...cell, at: Math.round(LEAD_MS + wait + i * each) })),
  );
}

// The data a result was measured on: which size, and how many users.
export type Data = Pick<Meta, 'preset' | 'users'>;

export function plan(
  scene: Scene,
  result: RunResult,
  baselineMs: Record<Engine, number> | null,
  data: Data,
  narrow = false,
): Plan {
  const { engines, headline } = result;
  const median = { pg: engines.pg.medianMs ?? 0, ch: engines.ch.medianMs ?? 0 };
  const winner = headline.winner;
  const loser: Engine | null = winner === 'pg' ? 'ch' : winner === 'ch' ? 'pg' : null;
  const ratio = winner && loser && median[winner] > 0 ? median[loser] / median[winner] : winner ? Infinity : 1;
  const d: Record<Engine, number> = { pg: SLOW_MS, ch: SLOW_MS };
  if (winner) d[winner] = Math.max(MIN_MS, SLOW_MS / ratio);
  const capped = !!winner && SLOW_MS / ratio < MIN_MS;
  const baseline = baselineMs ?? FALLBACK_BASELINE;
  const wait = (e: Engine) => d[e] * Math.min(median[e] > 0 ? baseline[e] / median[e] : 1, 0.8);

  const names = COLUMNS[scene.table];
  const sampleRows = scene.table === 'orders' ? SAMPLE_ROWS.orders[data.preset] : SAMPLE_ROWS.users;
  const shown = narrow ? scene.narrow : (scene.wide ?? names);
  const drawn = names.filter((name) => shown.includes(name));
  const folded = names.filter((name) => !drawn.includes(name));
  const used = new Set(usedColumns(scene));
  // Where a column is drawn: its own column, or "+N" at the end.
  const col = (name: string) => (drawn.includes(name) ? drawn.indexOf(name) : drawn.length);
  // A narrow card wraps headers after underscores, so only the longest line has to fit.
  const header = (name: string) => (narrow ? Math.max(...name.split(/(?<=_)/).map((s) => s.length)) : name.length);

  const columns: Column[] = drawn.map((name) => ({
    name,
    used: used.has(name),
    width: Math.max(header(name), ...sampleRows.map((row) => row[name].length)),
  }));
  if (folded.length) {
    const name = `+${folded.length}`;
    columns.push({ name, used: folded.some((c) => used.has(c)), width: name.length, more: folded });
  }
  const terms = scene.kind === 'search' ? scene.terms : [];
  const rows: Value[][] = sampleRows.map((row) => [
    ...drawn.map((name) => {
      const term = terms.find((t) => t.column === name);
      const mark = term && matchTerm(term, row[name]);
      return mark ? { text: row[name], mark } : { text: row[name] };
    }),
    ...(folded.length ? [{ text: '…' }] : []),
  ]);

  const every = sampleRows.map((_, r) => r);
  const found = every.filter((r) => passes(scene, sampleRows[r]));
  const n = names.length;
  const startup = baselineMs ? `about ${fmtMs(baselineMs.ch)}` : 'a few ms';
  // One step per cell: Postgres goes row by row, ClickHouse column by column.
  const byRow = (rs: number[]): Step[] => rs.flatMap((r) => columns.map((_, c) => [{ r, c }]));
  const byColumn = (rs: number[], cols: string[]): Step[] => cols.flatMap((name) => rs.map((r) => [{ r, c: col(name) }]));
  // The matches' other columns, all in one go.
  const rest = (rs: number[], cols: string[]): Step[] =>
    rs.length ? [rs.flatMap((r) => [...new Set(cols.map(col))].map((c) => ({ r, c })))] : [];
  let pg: Step[];
  let ch: Step[];
  let caption: Record<Engine, string>;

  switch (scene.kind) {
    case 'scan': {
      const k = `${scene.read.length} of ${n} columns`;
      pg = byRow(every);
      ch = byColumn(every, scene.read);
      caption =
        scene.table === 'orders'
          ? { pg: `Reads every row, all ${n} columns.`, ch: `Reads every row, but only ${k}, compressed.` }
          : { pg: `A small table: every row, all ${n} columns.`, ch: `Spends ${startup} starting up, then reads ${k}.` };
      break;
    }
    case 'range': {
      const k = `${scene.read.length} of ${n} columns`;
      pg = byRow(found);
      ch = byColumn(found, scene.read);
      caption = {
        pg: `Skips to ${scene.label}, then reads whole rows.`,
        ch: `Skips to ${scene.label}, then reads ${k}.`,
      };
      break;
    }
    case 'lookup': {
      pg = byRow(found);
      ch = [...byColumn(every, [scene.key]), ...rest(found, scene.out)];
      const plural = scene.key === 'id' ? 'row' : 'rows';
      caption = {
        pg: `Its index on ${scene.key} jumps straight to the ${plural}.`,
        ch: `Sorted by time, not ${scene.key}, so it scans the ${scene.key} column.`,
      };
      break;
    }
    case 'search': {
      const k = `${scene.read.length} of ${n} columns`;
      pg = byRow(every);
      ch = [...byColumn(every, scene.read), ...rest(found, scene.out)];
      // The drawn rows all come before the limit is reached, so both read every one of them.
      // With fewer matches than the limit, both read the whole table to be sure; ClickHouse
      // reads whole blocks of 8,192 rows, so its own count of rows read can say the same.
      const full = engines.pg.rows.length < scene.limit;
      const rowsRead = engines.ch.chStats?.rowsRead ?? null;
      caption = {
        pg: full ? `Walks every row in id order, all ${n} columns.` : `Walks rows in id order and stops at the ${scene.limit}th match.`,
        ch:
          full || (rowsRead !== null && rowsRead >= data.users)
            ? `Spends ${startup} starting up, then reads ${k} of every row.`
            : `Spends ${startup} starting up, then reads ${k} in id order, also stopping at the ${scene.limit}th match.`,
      };
      break;
    }
  }

  const filters = filterColumns(scene);
  const passing = new Set(found);
  const side = (e: Engine, steps: Step[]): Side => {
    const w = wait(e);
    const lit = timed(steps, d[e], w);
    // A row's verdict is in once the engine has read its filter columns.
    const filter = new Set(filters[e].map(col));
    const verdict = new Map<number, number>();
    for (const cell of lit) if (filter.has(cell.c)) verdict.set(cell.r, Math.max(verdict.get(cell.r) ?? 0, cell.at));
    const cells = lit.map((cell) => ({
      ...cell,
      hit: passing.has(cell.r) && columns[cell.c].used ? Math.max(cell.at, verdict.get(cell.r) ?? 0) : null,
    }));
    const touched = new Set(cells.map((cell) => cell.r));
    return { cells, skipped: every.filter((r) => !touched.has(r)), d: d[e], wait: w, caption: caption[e] };
  };
  const notes = [capped ? `The real gap is ${fmtRatio(headline.ratio ?? ratio)}, wider than drawn.` : null, scene.note];
  return {
    table: scene.table,
    columns,
    rows,
    pg: side('pg', pg),
    ch: side('ch', ch),
    note: notes.filter(Boolean).join(' ') || null,
  };
}
