// Do both engines return the same rows? Values are normalised first, because the drivers
// and type systems differ (PG numeric comes back as a string, CH Float64 as a number, PG
// dates as text with a time zone). Columns are matched by position, since unaliased columns
// get different names (PG "count", CH "count()"). Rows are compared as sorted multisets.

import type { Engine, MatchResult } from '../../shared/types';
import { TABLES } from '../../shared/schema';
import { hasLimit, type Prepared } from './guard';

const REL_TOLERANCE = 1e-9;

type Cell = null | bigint | number | string | Cell[];

const INT_RE = /^-?\d+$/;
const NUM_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function normTimestamp(m: RegExpExecArray): string {
  const [, date, time, frac = '', zone] = m;
  const fraction = frac.replace(/0+$/, '').replace(/^\.$/, '');
  if (!zone || /^(Z|[+-]00(:?00)?)$/.test(zone)) return `${date} ${time}${fraction}`;
  // A non-UTC offset: convert to UTC. Millisecond precision is enough for a comparison.
  const d = new Date(`${date}T${time}${frac}${zone.length === 3 ? `${zone}:00` : zone}`);
  if (Number.isNaN(d.getTime())) return m[0];
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const ms = iso.slice(19, 23).replace(/0+$/, '').replace(/^\.$/, '');
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}${ms}`;
}

export function normalise(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return null;
    return Number.isSafeInteger(v) ? BigInt(v) : v;
  }
  if (typeof v === 'string') {
    if (INT_RE.test(v)) return BigInt(v);
    if (NUM_RE.test(v)) {
      // Postgres numeric keeps its scale ("1740830401.000000"); a whole value is an integer.
      const n = Number(v);
      return Number.isSafeInteger(n) ? BigInt(n) : n;
    }
    if (v === 'NaN' || v === 'nan') return null;
    if (v === 'Infinity' || v === 'inf' || v === '+inf') return Infinity;
    if (v === '-Infinity' || v === '-inf') return -Infinity;
    if (DATE_RE.test(v)) return `${v} 00:00:00`;
    const ts = TS_RE.exec(v);
    if (ts) return normTimestamp(ts);
    return v;
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (v instanceof Date) return normTimestamp(TS_RE.exec(v.toISOString())!);
  // JSON objects and maps: compare their content with sorted keys.
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
}

const isNum = (c: Cell): c is bigint | number => typeof c === 'bigint' || typeof c === 'number';

function numEqual(a: bigint | number, b: bigint | number): boolean {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b;
  const x = Number(a);
  const y = Number(b);
  if (x === y) return true;
  return Math.abs(x - y) <= REL_TOLERANCE * Math.max(Math.abs(x), Math.abs(y));
}

export function cellEqual(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return a === b;
  if (isNum(a) && isNum(b)) return numEqual(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => cellEqual(x, b[i]));
  return a === b;
}

// Sorting only has to put equal rows next to each other on both sides. Numbers are first
// ordered by their value rounded to 9 significant digits, whatever their type, so an integer
// and a float within the tolerance land in the same place on both sides; the tolerance decides
// equality afterwards. Rows that tie on every rounded cell are then ordered exactly, so big
// integers that differ only past the 9th digit still sort the same way on both sides.
const typeRank = (c: Cell) => (c === null ? 0 : isNum(c) ? 1 : typeof c === 'string' ? 2 : 3);
const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

function cellOrder(a: Cell, b: Cell, exact: boolean): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (isNum(a) && isNum(b)) {
    if (!exact) return cmp(Number(Number(a).toPrecision(9)), Number(Number(b).toPrecision(9)));
    return typeof a === 'bigint' && typeof b === 'bigint' ? cmp(a, b) : cmp(Number(a), Number(b));
  }
  if (typeof a === 'string' && typeof b === 'string') return cmp(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return cellsOrder(a, b, exact);
  return 0;
}

function cellsOrder(a: Cell[], b: Cell[], exact: boolean): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = cellOrder(a[i], b[i], exact);
    if (c) return c;
  }
  return a.length - b.length;
}

const rowOrder = (a: Cell[], b: Cell[]) => cellsOrder(a, b, false) || cellsOrder(a, b, true);

export function display(c: Cell): string {
  if (c === null) return 'NULL';
  if (Array.isArray(c)) return `[${c.map(display).join(', ')}]`;
  return String(c);
}

export interface Side {
  columns: string[];
  types: string[];
  rows: unknown[][];
  // More rows than the cap came back, so each engine may have picked different rows.
  truncated: boolean;
}

interface Difference {
  detail: string;
  column: number | null;
}

function firstDifference(pg: Side, ch: Side): Difference | null {
  if (pg.columns.length !== ch.columns.length) {
    return { detail: `Postgres returned ${pg.columns.length} columns, ClickHouse ${ch.columns.length}.`, column: null };
  }
  if (pg.rows.length !== ch.rows.length) {
    return { detail: `Postgres returned ${pg.rows.length} rows, ClickHouse ${ch.rows.length}.`, column: null };
  }
  const a = pg.rows.map((r) => r.map(normalise)).sort(rowOrder);
  const b = ch.rows.map((r) => r.map(normalise)).sort(rowOrder);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) {
      if (!cellEqual(a[i][j], b[i][j])) {
        const name = pg.columns[j] === ch.columns[j] ? pg.columns[j] : `${pg.columns[j]} / ${ch.columns[j]}`;
        return {
          detail: `First difference (rows compared in sorted order), column ${j + 1} "${name}": Postgres ${display(a[i][j])}, ClickHouse ${display(b[i][j])}.`,
          column: j,
        };
      }
    }
  }
  return null;
}

const COLUMN_NAMES = new Set(TABLES.flatMap((t) => t.columns.map((c) => c.name)));
const PG_INT_TYPES = new Set(['smallint', 'integer', 'bigint', 'int2', 'int4', 'int8']);
const isChInt = (t: string) => /^(Nullable\()?U?Int\d+/.test(t);
const isFloat = (t: string) => /Float|double|real|numeric|Decimal/.test(t);

// Known dialect differences, checked against the SQL and the column types of the first difference.
function mismatchHint(pg: Side, ch: Side, diff: Difference, sql: { pg: Prepared; ch: Prepared; raw: string }): string | null {
  const j = diff.column;
  const pgType = j === null ? '' : pg.types[j] ?? '';
  const chType = j === null ? '' : ch.types[j] ?? '';
  const words = new Set([...sql.pg.words, ...sql.ch.words]);
  if (j !== null && sql.raw.includes('/') && ((PG_INT_TYPES.has(pgType) && isFloat(chType)) || (isChInt(chType) && isFloat(pgType)))) {
    return 'Division differs: in Postgres 7 / 2 = 3 (integer division), in ClickHouse 7 / 2 = 3.5. Write x * 1.0 / y to get the same result on both.';
  }
  if (words.has('round')) {
    return 'round() differs on ties: ClickHouse rounds floats half to even (2.5 → 2), Postgres rounds half away from zero (2.5 → 3). Compare without round().';
  }
  if (words.has('length')) {
    return 'length() counts characters in Postgres but bytes in ClickHouse. Use char_length() in Postgres and lengthUTF8() in ClickHouse.';
  }
  if (words.has('now') || words.has('current_date') || words.has('today') || words.has('current_timestamp')) {
    return 'The two engines ran a moment apart, so now() / today() can differ. Use a fixed date literal instead.';
  }
  if (words.has('date_trunc') || words.has('tostartofmonth')) {
    return 'date_trunc() returns a timestamp in Postgres but may return a Date or DateTime in ClickHouse. Wrap it in CAST(… AS DATE) on both.';
  }
  if (words.has('random') || words.has('rand')) return 'Random functions give different values on each engine and each run.';
  for (const m of sql.raw.matchAll(/\bas\s+"?([a-z_][a-z0-9_]*)"?/gi)) {
    if (COLUMN_NAMES.has(m[1].toLowerCase())) {
      return `The alias "${m[1]}" is also a column name. The engines resolve such an alias differently in WHERE, GROUP BY and ORDER BY; rename the alias.`;
    }
  }
  if (/String|text/.test(pgType + chType) && (words.has('lower') || words.has('upper') || words.has('ilike'))) {
    return 'Case conversion of non-ASCII letters can differ between the engines.';
  }
  return null;
}

export function compareResults(
  pg: Side,
  ch: Side,
  sql: { pg: Prepared; ch: Prepared; raw: string },
): MatchResult {
  const diff = firstDifference(pg, ch);
  if (!diff) return { kind: 'match', detail: null, hint: null };
  if (pg.truncated || ch.truncated || hasLimit(sql.pg) || hasLimit(sql.ch)) {
    return {
      kind: 'not-comparable',
      detail: 'Rows are cut off or unordered, so each engine may pick different rows.',
      hint: diff.detail,
    };
  }
  return { kind: 'mismatch', detail: diff.detail, hint: mismatchHint(pg, ch, diff, sql) };
}

// ---- Errors ----

// ClickHouse error text looks like "Code: 47. DB::Exception: Unknown identifier … (UNKNOWN_IDENTIFIER) (version 26.8.1.1)".
export function cleanChError(message: string): string {
  return message
    .replace(/^Code:\s*\d+\.\s*/, '')
    .replace(/^DB::Exception:\s*/, '')
    .replace(/\s*\(version [^)]*\)\s*$/, '')
    .replace(/\s*Stack trace:[\s\S]*$/, '')
    .trim();
}

const PG_TO_CH: [RegExp, string][] = [
  [/\bto_char\b/i, 'formatDateTime(created_at, \'%Y-%m\')'],
  [/\bstring_agg\b/i, 'arrayStringConcat(groupArray(x), \', \')'],
  [/\barray_agg\b/i, 'groupArray(x)'],
  [/\bpercentile_cont\b/i, 'quantileExactInclusive(0.5)(x)'],
  [/\bpercentile_disc\b/i, 'quantileExact(0.5)(x)'],
  [/\bgenerate_series\b/i, 'numbers(n) or range(a, b)'],
  [/\bdate_part\b/i, 'toYear(x), toMonth(x), … or extract(year FROM x)'],
  [/\bage\b/i, 'dateDiff(\'year\', a, b)'],
  [/\bstddev\b/i, 'stddevSamp(x)'],
];

const CH_TO_PG: [RegExp, string][] = [
  [/\buniq(Exact)?\b/i, 'count(DISTINCT x)'],
  [/\bquantile\w*\b/i, 'percentile_cont(0.5) WITHIN GROUP (ORDER BY x)'],
  [/\bcountIf\b/i, 'count(*) FILTER (WHERE cond)'],
  [/\bsumIf\b/i, 'sum(x) FILTER (WHERE cond)'],
  [/\btoStartOf(Month|Day|Week|Year|Hour)\b/i, 'date_trunc(\'month\', x)'],
  [/\btoYear|toMonth|toDayOfWeek\b/i, 'extract(year FROM x)'],
  [/\btoDate\b/i, 'CAST(x AS DATE)'],
  [/\bgroupArray\b/i, 'array_agg(x)'],
  [/\bformatDateTime\b/i, 'to_char(x, \'YYYY-MM\')'],
  [/\barrayJoin\b/i, 'unnest(x)'],
  [/\bany\b/i, 'min(x) (or add the column to GROUP BY)'],
  [/\blengthUTF8\b/i, 'char_length(x)'],
  [/\bdateDiff\b/i, 'x - y, or extract(epoch FROM x - y)'],
];

// A short tip shown under an error in one engine's lane.
export function errorHint(engine: Engine, message: string, sql: string): string | null {
  const m = message.toLowerCase();
  if (/read-only|readonly mode|cannot execute .* in a read-only transaction/.test(m)) {
    return 'Only SELECT queries can run here.';
  }
  if (/should not be changed|setting_constraint_violation|readonly/.test(m) && engine === 'ch') {
    return 'This setting is locked so both engines get the same budget (see the README).';
  }
  if (/memory limit|memory_limit_exceeded/.test(m)) return 'ClickHouse stopped at its 1 GB per-query memory limit.';
  if (/temp_file_limit/.test(m)) return 'Postgres stopped at its 100 MB temp-file limit for one query.';
  if (/max bytes/.test(m)) return 'The result was larger than 64 MB. Aggregate, or select fewer or smaller columns.';
  if (/too many rows|too_many_rows_or_bytes/.test(m)) return 'The result had more than 10,000 rows. Aggregate or add a LIMIT.';
  if (/must appear in the group by clause|not under aggregate function and not in group by/.test(m)) {
    return 'Every selected column must be in GROUP BY or inside an aggregate such as min() or count().';
  }
  if (engine === 'ch' && /unknown (function|aggregate function)|function with name .* does not exist|unknown_function/.test(m)) {
    for (const [re, tip] of PG_TO_CH) if (re.test(sql)) return `That function is Postgres-only. In ClickHouse try ${tip}. Use "Separate SQL per engine" to write each dialect.`;
    return 'ClickHouse has no function by that name. Use "Separate SQL per engine" to write the ClickHouse version.';
  }
  if (engine === 'pg' && /function .* does not exist/.test(m)) {
    for (const [re, tip] of CH_TO_PG) if (re.test(sql)) return `That function is ClickHouse-only. In Postgres try ${tip}. Use "Separate SQL per engine" to write each dialect.`;
    return 'Postgres has no function with that name and argument types. Check the types or add a CAST.';
  }
  if (engine === 'pg' && /operator does not exist/.test(m)) return 'Postgres is strict about types. Add a CAST so both sides have the same type.';
  if (engine === 'ch' && /no supertype|illegal type|type_mismatch|cannot convert/.test(m)) {
    return 'ClickHouse is strict about types. Compare like with like, or add a CAST.';
  }
  if (engine === 'pg' && /invalid input value for enum/.test(m)) return 'That value is not one of the enum\'s values (see the schema above).';
  if (engine === 'ch' && /unknown element .* for enum|unknown_element_of_enum/.test(m)) return 'That value is not one of the enum\'s values (see the schema above).';
  if (/unknown (identifier|expression identifier)|column .* does not exist|missing columns/.test(m)) {
    return 'Check the column names in the schema above. An alias defined in SELECT can\'t always be used in WHERE on both engines.';
  }
  if (/syntax error/.test(m)) return 'The two dialects differ in places. Use "Separate SQL per engine" to write each one.';
  return null;
}
