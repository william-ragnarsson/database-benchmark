import { describe, expect, it } from 'vitest';
import { cellEqual, cleanChError, compareResults, errorHint, normalise, type Side } from '../src/server/bench/compare';
import { prepare } from '../src/server/bench/guard';

const side = (rows: unknown[][], over: Partial<Side> = {}): Side => ({
  columns: (rows[0] ?? []).map((_, i) => `c${i + 1}`),
  types: [],
  rows,
  truncated: false,
  ...over,
});
const sqlFor = (sql: string) => ({ pg: prepare(sql, 'pg'), ch: prepare(sql, 'ch'), raw: sql });
const same = (a: unknown, b: unknown) => cellEqual(normalise(a), normalise(b));

describe('normalise', () => {
  it('turns integers into BigInt and other numbers into floats', () => {
    expect(normalise('42')).toBe(42n);
    expect(normalise(42)).toBe(42n);
    expect(normalise('-7')).toBe(-7n);
    expect(normalise(42.5)).toBe(42.5);
    expect(normalise('42.50')).toBe(42.5);
    expect(normalise('1e3')).toBe(1000n);
    expect(normalise('1740830401.000000')).toBe(1740830401n);
    expect(normalise(true)).toBe(1n);
  });

  it('treats NaN as NULL and reads both spellings of infinity', () => {
    expect(normalise(NaN)).toBeNull();
    expect(normalise('NaN')).toBeNull();
    expect(normalise('nan')).toBeNull();
    expect(normalise(undefined)).toBeNull();
    expect(normalise('Infinity')).toBe(Infinity);
    expect(normalise('inf')).toBe(Infinity);
    expect(normalise('-inf')).toBe(-Infinity);
  });

  it('writes dates and timestamps as UTC "YYYY-MM-DD HH:MM:SS"', () => {
    expect(normalise('2025-03-01')).toBe('2025-03-01 00:00:00');
    expect(normalise('2025-03-01 10:00:00')).toBe('2025-03-01 10:00:00');
    expect(normalise('2025-03-01T10:00:00Z')).toBe('2025-03-01 10:00:00');
    expect(normalise('2025-03-01 10:00:00+00')).toBe('2025-03-01 10:00:00');
    expect(normalise('2025-03-01 10:00:00.000')).toBe('2025-03-01 10:00:00');
    expect(normalise('2025-03-01 10:00:00.120')).toBe('2025-03-01 10:00:00.12');
    expect(normalise('2025-03-01 12:00:00+02')).toBe('2025-03-01 10:00:00');
    expect(normalise('2025-03-01 00:30:00+05:30')).toBe('2025-02-28 19:00:00');
    expect(normalise(new Date(Date.UTC(2025, 2, 1, 10)))).toBe('2025-03-01 10:00:00');
  });

  it('compares objects by content, whatever the key order, and keeps other text as it is', () => {
    expect(normalise({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(normalise([1, '2', null])).toEqual([1n, 2n, null]);
    expect(normalise('Stockholm')).toBe('Stockholm');
  });
});

describe('cellEqual', () => {
  it('accepts a Postgres numeric string against a ClickHouse float within 1e-9', () => {
    expect(same('123.456000', 123.456)).toBe(true);
    expect(same('0.1', 0.1 + 1e-12)).toBe(true);
    expect(same('1234.5', 1234.6)).toBe(false);
    expect(same('2.5', '2.50')).toBe(true);
  });

  it('compares big integers exactly, and against floats by value', () => {
    expect(same('100000000000000000000', 1e20)).toBe(true);
    expect(same('9007199254740993', '9007199254740992')).toBe(false);
    expect(same(3, '3')).toBe(true);
  });

  it('only matches NULL with NULL', () => {
    expect(same(null, null)).toBe(true);
    expect(same(null, 0)).toBe(false);
    expect(same('', null)).toBe(false);
  });

  it('matches a date with the same date at midnight', () => {
    expect(same('2025-03-01', '2025-03-01 00:00:00')).toBe(true);
    expect(same('2025-03-01 10:00:00+00', '2025-03-01 10:00:00')).toBe(true);
  });
});

describe('compareResults', () => {
  const plain = sqlFor('SELECT a, b FROM t');

  it('compares rows as a multiset, with duplicates counted', () => {
    const pg = side([[1, 'a'], [2, 'b'], [1, 'a']]);
    expect(compareResults(pg, side([[2, 'b'], [1, 'a'], [1, 'a']]), plain).kind).toBe('match');
    expect(compareResults(pg, side([[1, 'a'], [2, 'b'], [2, 'b']]), plain).kind).toBe('mismatch');
  });

  it('matches numeric strings, NaN vs NULL and timestamps across drivers', () => {
    const pg = side([['10.50', 'NaN', '2025-03-01 10:00:00+00', '2025-03-01']]);
    const ch = side([[10.5, null, '2025-03-01 10:00:00', '2025-03-01 00:00:00']]);
    expect(compareResults(pg, ch, plain)).toEqual({ kind: 'match', detail: null, hint: null });
  });

  it('sorts whole Postgres numerics the same way as ClickHouse integers', () => {
    // extract(epoch …) is numeric with a scale in Postgres and an integer in ClickHouse.
    const pg = side([['1740830401.000000', 'toys'], ['1740830404.000000', 'books']]);
    const ch = side([[1740830401, 'toys'], [1740830404, 'books']]);
    expect(compareResults(pg, ch, plain).kind).toBe('match');
  });

  it('sorts a float and an integer within the tolerance into the same place', () => {
    const pg = side([[1740830401, 'b'], [1740830402, 'a']]);
    const ch = side([[1740830401.0000001, 'b'], [1740830402, 'a']]);
    expect(compareResults(pg, ch, plain).kind).toBe('match');
  });

  it('orders big integers that differ past the 9th digit exactly', () => {
    const pg = side([['1234567890123', 'x'], ['1234567890124', 'a']]);
    const ch = side([['1234567890124', 'a'], ['1234567890123', 'x']]);
    expect(compareResults(pg, ch, plain).kind).toBe('match');
  });

  it('matches columns by position, not by name', () => {
    const pg = side([[5]], { columns: ['count'] });
    const ch = side([['5']], { columns: ['count()'] });
    expect(compareResults(pg, ch, sqlFor('SELECT count(*) FROM orders')).kind).toBe('match');
  });

  it('reports different column and row counts', () => {
    expect(compareResults(side([[1, 2]]), side([[1, 2, 3]]), plain)).toMatchObject({
      kind: 'mismatch',
      detail: 'Postgres returned 2 columns, ClickHouse 3.',
    });
    expect(compareResults(side([[1], [2]]), side([[1], [2], [3]]), plain).detail).toBe('Postgres returned 2 rows, ClickHouse 3.');
  });

  it('names the first differing cell', () => {
    const r = compareResults(side([[1, 'x']], { columns: ['id', 'name'] }), side([[1, 'y']], { columns: ['id', 'name'] }), plain);
    expect(r.kind).toBe('mismatch');
    expect(r.detail).toBe('First difference (rows compared in sorted order), column 2 "name": Postgres x, ClickHouse y.');
  });

  it('says "not comparable" when rows were cut off or the SQL has a LIMIT', () => {
    const a = side([[1], [2]]);
    const b = side([[1], [3]]);
    expect(compareResults(a, { ...b, truncated: true }, plain).kind).toBe('not-comparable');
    expect(compareResults(a, b, sqlFor('SELECT id FROM orders LIMIT 2')).kind).toBe('not-comparable');
    // Equal rows are still a match.
    expect(compareResults(a, { ...a, truncated: true }, plain).kind).toBe('match');
  });

  it('explains integer division', () => {
    const r = compareResults(
      side([[3]], { types: ['integer'] }),
      side([[3.5]], { types: ['Float64'] }),
      sqlFor('SELECT quantity / 2 FROM orders'),
    );
    expect(r.kind).toBe('mismatch');
    expect(r.hint).toMatch(/^Division differs/);
  });

  it('explains round(), now() and an alias that shadows a column', () => {
    const differ = (sql: string) => compareResults(side([[2]]), side([[3]]), sqlFor(sql)).hint;
    expect(differ('SELECT round(2.5)')).toMatch(/^round\(\) differs/);
    expect(differ('SELECT count(*) FROM orders WHERE created_at > now()')).toMatch(/now\(\)/);
    expect(differ('SELECT price_cents * 2 AS price_cents FROM orders ORDER BY price_cents')).toMatch(/alias "price_cents"/);
    expect(differ('SELECT 1')).toBeNull();
  });
});

describe('cleanChError', () => {
  it('drops the code, the exception prefix, the version and the stack trace', () => {
    expect(cleanChError('Code: 47. DB::Exception: Unknown expression identifier `foo` in scope SELECT foo. (UNKNOWN_IDENTIFIER) (version 26.8.1.1)'))
      .toBe('Unknown expression identifier `foo` in scope SELECT foo. (UNKNOWN_IDENTIFIER)');
    expect(cleanChError('Code: 62. DB::Exception: Syntax error. Stack trace:\n0. foo\n1. bar')).toBe('Syntax error.');
  });
});

describe('errorHint', () => {
  it('suggests the other dialect’s function', () => {
    expect(errorHint('ch', 'Unknown function to_char. (UNKNOWN_FUNCTION)', "SELECT to_char(created_at, 'YYYY-MM') FROM orders"))
      .toMatch(/formatDateTime/);
    expect(errorHint('pg', 'function uniq(integer) does not exist', 'SELECT uniq(user_id) FROM orders')).toMatch(/count\(DISTINCT x\)/);
    expect(errorHint('pg', 'function countif(boolean) does not exist', "SELECT countIf(status = 'pending') FROM orders")).toMatch(/FILTER/);
  });

  it('explains the limits', () => {
    expect(errorHint('ch', 'Memory limit (for query) exceeded: would use 1.00 GiB. (MEMORY_LIMIT_EXCEEDED)', '')).toMatch(/1 GB/);
    expect(errorHint('pg', 'temporary file size exceeds temp_file_limit (102400kB)', '')).toMatch(/100 MB temp-file limit/);
    expect(errorHint('ch', 'Limit for result exceeded, max rows: 10.00 thousand. (TOO_MANY_ROWS_OR_BYTES)', '')).toMatch(/10,000 rows/);
    expect(errorHint('ch', 'Limit for result exceeded, max bytes: 64.00 MiB, current bytes: 70.12 MiB. (TOO_MANY_ROWS_OR_BYTES)', '')).toMatch(/64 MB/);
    expect(errorHint('ch', 'Setting max_threads should not be changed. (SETTING_CONSTRAINT_VIOLATION)', '')).toMatch(/locked/);
    expect(errorHint('pg', 'cannot execute INSERT in a read-only transaction', '')).toBe('Only SELECT queries can run here.');
  });

  it('points at the schema, GROUP BY and dialect tabs', () => {
    expect(errorHint('pg', 'column "foo" does not exist', '')).toMatch(/column names/);
    expect(errorHint('pg', 'column "orders.category" must appear in the GROUP BY clause or be used in an aggregate function', ''))
      .toMatch(/GROUP BY/);
    expect(errorHint('pg', 'invalid input value for enum order_status: "done"', '')).toMatch(/enum/);
    expect(errorHint('pg', 'syntax error at or near "FROM"', '')).toMatch(/Separate SQL per engine/);
    expect(errorHint('pg', 'division by zero', '')).toBeNull();
  });
});
