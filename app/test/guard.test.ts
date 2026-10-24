import { describe, expect, it } from 'vitest';
import { FETCH_ROWS, GuardError, hasLimit, looksAggregating, prepare, wrap } from '../src/server/bench/guard';
import { prepareRun } from '../src/server/bench/runner';
import { TEMPLATES, templateSql } from '../src/shared/templates';
import type { Engine } from '../src/shared/types';

const both: Engine[] = ['pg', 'ch'];
const sqlOf = (sql: string, engine: Engine = 'pg') => prepare(sql, engine).sql;
const rejects = (sql: string, message: RegExp, engine: Engine = 'pg') =>
  expect(() => prepare(sql, engine)).toThrow(message);

describe('prepare: what is accepted', () => {
  it.each(both)('accepts every template on %s', (engine) => {
    for (const t of TEMPLATES) expect(() => prepare(templateSql(t)[engine], engine), t.id).not.toThrow();
  });

  it('accepts SELECT, WITH and a parenthesised query, in any case', () => {
    expect(sqlOf('select 1')).toBe('select 1');
    expect(sqlOf('WITH t AS (SELECT 1 AS x) SELECT x FROM t')).toContain('WITH');
    expect(sqlOf('(SELECT 1) UNION ALL (SELECT 2)')).toBe('(SELECT 1) UNION ALL (SELECT 2)');
  });

  it('accepts WITH … AS MATERIALIZED', () => {
    expect(() => prepare('WITH t AS MATERIALIZED (SELECT 1 AS x) SELECT x FROM t', 'pg')).not.toThrow();
  });

  it('accepts leading comments', () => {
    expect(sqlOf('-- revenue\n/* by day */ SELECT 1')).toBe('-- revenue\n/* by day */ SELECT 1');
  });

  it.each([
    ['SELECT 1;', 'SELECT 1'],
    ['SELECT 1 ;; \n', 'SELECT 1'],
    ['SELECT 1 -- done', 'SELECT 1'],
    ['SELECT 1; -- done', 'SELECT 1'],
    ['SELECT 1 /* done */', 'SELECT 1'],
    ['SELECT 1; /* a */ -- b\n ;', 'SELECT 1'],
  ])('strips trailing semicolons and comments: %j', (input, out) => {
    expect(sqlOf(input)).toBe(out);
  });

  it('ignores semicolons and write keywords inside strings, quoted names and comments', () => {
    expect(() => prepare("SELECT 'a;b; DELETE FROM orders' AS s", 'pg')).not.toThrow();
    expect(() => prepare('SELECT 1 AS "delete;"', 'pg')).not.toThrow();
    expect(() => prepare('SELECT 1 /* ; drop table orders; */ AS x', 'pg')).not.toThrow();
    expect(() => prepare('SELECT 1 -- ; update orders\nAS x', 'pg')).not.toThrow();
    expect(() => prepare('SELECT 1 AS `x;y`', 'ch')).not.toThrow();
    expect(() => prepare('SELECT 1 # ; insert\nAS x', 'ch')).not.toThrow();
  });

  it('only matches whole words, so columns like update_time are fine', () => {
    expect(() => prepare('SELECT updated_at, deleted, merges FROM t', 'pg')).not.toThrow();
  });

  it('knows each dialect’s string escapes', () => {
    // A backslash escapes a quote in ClickHouse and in Postgres E'' strings, but not in plain Postgres strings.
    expect(() => prepare("SELECT 'it\\'s; fine'", 'ch')).not.toThrow();
    expect(() => prepare("SELECT E'it\\'s; fine'", 'pg')).not.toThrow();
    expect(() => prepare("SELECT 'it''s; fine'", 'pg')).not.toThrow();
    expect(() => prepare('SELECT $$a;b$$, $tag$c;d$tag$', 'pg')).not.toThrow();
  });

  it('handles nested block comments', () => {
    expect(sqlOf('/* a /* b; */ c; */ SELECT 1 /* x /* y */ z */')).toBe('/* a /* b; */ c; */ SELECT 1');
  });

  it('lists the lowercased words outside strings and comments', () => {
    const p = prepare("SELECT Count(*) FROM Orders WHERE status = 'LIMIT' -- order by", 'pg');
    expect([...p.words].sort()).toEqual(['count', 'from', 'orders', 'select', 'status', 'where']);
  });
});

describe('prepare: what is rejected', () => {
  it('rejects empty input', () => {
    rejects('', /empty/);
    rejects('  ;  -- nothing\n', /empty/);
  });

  it.each(['DROP TABLE orders', 'TRUNCATE orders', 'CREATE TABLE x (a int)', 'SET work_mem = 1', 'COPY orders TO STDOUT', 'EXPLAIN SELECT 1', 'SHOW TABLES'])(
    'rejects anything that does not start with SELECT or WITH: %s',
    (sql) => rejects(sql, /Only SELECT queries/),
  );

  it('rejects more than one statement', () => {
    rejects('SELECT 1; SELECT 2', /one statement/);
    rejects('SELECT 1; DROP TABLE orders', /one statement/);
  });

  it('rejects data-changing statements, including inside WITH', () => {
    rejects('WITH d AS (DELETE FROM orders RETURNING *) SELECT * FROM d', /contains DELETE/);
    rejects('WITH u AS (UPDATE orders SET quantity = 0 RETURNING id) SELECT count(*) FROM u', /contains UPDATE/);
    rejects('WITH i AS (INSERT INTO orders DEFAULT VALUES RETURNING id) SELECT 1', /contains INSERT/);
    rejects('WITH m AS (MERGE INTO orders USING users ON true WHEN MATCHED THEN DO NOTHING RETURNING 1) SELECT 1', /contains MERGE/);
  });

  it('rejects unclosed quotes and comments', () => {
    rejects("SELECT 'abc", /unclosed quote/);
    rejects('SELECT "abc', /unclosed quote/);
    rejects('SELECT 1 /* never closed', /unclosed \/\* comment/);
    rejects('SELECT $$abc', /unclosed \$\$ string/);
    // In plain Postgres strings a backslash is an ordinary character, so the quote after it ends the string.
    rejects("SELECT 'it\\'s'", /unclosed quote/, 'pg');
  });

  it('throws GuardError, so the route can show the message', () => {
    expect(() => prepare('DROP TABLE orders', 'pg')).toThrow(GuardError);
  });
});

describe('wrap', () => {
  it('puts the query on its own lines so a trailing comment cannot swallow the LIMIT', () => {
    const w = wrap('SELECT 1 -- note\nFROM t');
    expect(w).toBe(`SELECT * FROM (\nSELECT 1 -- note\nFROM t\n) q LIMIT ${FETCH_ROWS}`);
    expect(FETCH_ROWS).toBe(101);
  });
});

describe('hasLimit and looksAggregating', () => {
  it('spots LIMIT, OFFSET and FETCH as words only', () => {
    expect(hasLimit(prepare('SELECT * FROM orders LIMIT 5', 'pg'))).toBe(true);
    expect(hasLimit(prepare('SELECT * FROM orders OFFSET 5', 'pg'))).toBe(true);
    expect(hasLimit(prepare('SELECT * FROM orders FETCH FIRST 5 ROWS ONLY', 'pg'))).toBe(true);
    expect(hasLimit(prepare("SELECT 'limit' AS limits FROM orders", 'pg'))).toBe(false);
  });

  it('spots aggregations, including ClickHouse quantile functions', () => {
    expect(looksAggregating(prepare('SELECT * FROM orders', 'pg'))).toBe(false);
    expect(looksAggregating(prepare('SELECT count(*) FROM orders', 'pg'))).toBe(true);
    expect(looksAggregating(prepare('SELECT DISTINCT category FROM orders', 'pg'))).toBe(true);
    expect(looksAggregating(prepare('SELECT * FROM orders ORDER BY id', 'pg'))).toBe(true);
    expect(looksAggregating(prepare('SELECT quantileTDigest(0.5)(price_cents) FROM orders', 'ch'))).toBe(true);
  });
});

describe('prepareRun (request validation)', () => {
  it('defaults to 5 runs and checks the template id', () => {
    const r = prepareRun({ pg: 'SELECT 1', ch: 'SELECT 1', templateId: 'order-by-id' });
    expect(r.runs).toBe(5);
    expect(r.templateId).toBe('order-by-id');
    expect(prepareRun({ pg: 'SELECT 1', ch: 'SELECT 1', templateId: 'nope' }).templateId).toBeNull();
  });

  it('rejects bad bodies', () => {
    expect(() => prepareRun(null)).toThrow(/required/);
    expect(() => prepareRun({ pg: 'SELECT 1' })).toThrow(/required/);
    expect(() => prepareRun({ pg: 'SELECT 1', ch: 'SELECT 1', runs: 4 })).toThrow(/1, 3 or 5/);
    expect(() => prepareRun({ pg: 'x'.repeat(1_000_000), ch: 'SELECT 1' })).toThrow(/too long/);
  });

  it('names the engine only when the two SQL texts differ', () => {
    expect(() => prepareRun({ pg: 'DROP TABLE orders', ch: 'DROP TABLE orders' })).toThrow(/^Only SELECT/);
    expect(() => prepareRun({ pg: 'SELECT 1', ch: 'SELECT 1; SELECT 2' })).toThrow(/^ClickHouse SQL: Only one statement/);
  });
});
