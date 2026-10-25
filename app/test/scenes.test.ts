import { describe, expect, it } from 'vitest';
import { LEAD_MS, MIN_MS, SAMPLE_ROWS, SCENES, SLOW_MS, plan, requiredColumns, type Data, type Side } from '../src/client/scenes';
import { CHUNK_ROWS, DEFAULT_SEED, OrderGenerator, userChunk, userCountries } from '../src/server/seed/generator';
import { PRESETS } from '../src/shared/presets';
import { TABLES } from '../src/shared/schema';
import { TEMPLATES } from '../src/shared/templates';
import type { Engine, EngineResult, Headline, RunResult } from '../src/shared/types';

const engine = (medianMs: number, columns: string[] = [], rows: unknown[][] = []): EngineResult => ({
  status: 'ok',
  warmupMs: medianMs,
  runsMs: [medianMs],
  medianMs,
  slow: false,
  columns,
  types: [],
  rows,
  truncated: false,
  error: null,
  hint: null,
  chStats: null,
});

const result = (templateId: string, pg: EngineResult, ch: EngineResult, winner: Engine | null): RunResult => {
  const fast = Math.min(pg.medianMs!, ch.medianMs!);
  const headline: Headline = {
    text: '',
    winner,
    ratio: winner ? Math.max(pg.medianMs!, ch.medianMs!) / fast : null,
    lowerBound: false,
    instant: false,
  };
  return { runId: 'r', templateId, engines: { pg, ch }, headline, match: { kind: 'match', detail: null, hint: null }, truncationHint: false, totalMs: 0 };
};

const BASELINE = { pg: 0.3, ch: 3 };
const STANDARD: Data = { preset: 'standard', users: 100_000, orders: 1_000_000 };

// The cells of one row, or of one column, in the order they light.
const row = (side: Side, r: number) => side.cells.filter((c) => c.r === r);
const column = (side: Side, c: number) => side.cells.filter((cell) => cell.c === c);
const rowsOf = (side: Side) => [...new Set(side.cells.map((c) => c.r))].sort((a, b) => a - b);

describe('SCENES', () => {
  it('has one scene for each template, and no others', () => {
    expect(Object.keys(SCENES).sort()).toEqual(TEMPLATES.map((t) => t.id).sort());
  });

  it('only names columns the table has', () => {
    for (const scene of Object.values(SCENES)) {
      const names = TABLES.find((t) => t.name === scene.table)!.columns.map((c) => c.name);
      const named = [
        ...scene.narrow,
        ...(scene.wide ?? []),
        ...('read' in scene ? scene.read : []),
        ...('out' in scene ? scene.out : []),
        ...('key' in scene ? [scene.key] : []),
        ...('keep' in scene && scene.keep ? [scene.keep.column] : []),
        ...('terms' in scene ? scene.terms.map((t) => t.column) : []),
      ];
      for (const name of named) expect(names).toContain(name);
    }
  });

  it('draws every column ClickHouse reads or filters on, in both layouts', () => {
    for (const [id, scene] of Object.entries(SCENES)) {
      for (const narrow of [false, true]) {
        const p = plan(scene, result(id, engine(10), engine(5), 'ch'), BASELINE, STANDARD, narrow);
        const drawn = p.columns.filter((c) => !c.more).map((c) => c.name);
        for (const name of requiredColumns(scene)) expect(drawn, `${id} ${narrow ? 'narrow' : 'wide'}`).toContain(name);
      }
    }
  });
});

describe('SAMPLE_ROWS', () => {
  const values = (table: 'orders' | 'users', row: Record<string, string>) =>
    TABLES.find((t) => t.name === table)!.columns.map((c) => row[c.name]);
  const line = (text: string, id: number) => text.split('\n')[(id - 1) % CHUNK_ROWS].split('\t');

  it('are the seeded rows at every size', () => {
    for (const preset of PRESETS) {
      const spec = { seed: DEFAULT_SEED, users: preset.users, orders: preset.orders };
      const orders = new OrderGenerator(spec, userCountries(spec));
      for (const row of SAMPLE_ROWS.orders[preset.id]) {
        const id = Number(row.id);
        expect(values('orders', row), preset.id).toEqual(line(orders.chunk(Math.floor((id - 1) / CHUNK_ROWS)).text, id));
      }
      const users = userChunk(spec, 0).text;
      for (const row of SAMPLE_ROWS.users) expect(values('users', row), preset.id).toEqual(line(users, Number(row.id)));
    }
  });

  it('have rows on both sides of every filter, at every size', () => {
    for (const preset of PRESETS) {
      for (const [id, scene] of Object.entries(SCENES)) {
        if (scene.kind === 'scan' && !scene.keep) continue;
        const p = plan(scene, result(id, engine(10), engine(5), 'ch'), BASELINE, { preset: preset.id, users: preset.users, orders: preset.orders });
        const found = new Set([...p.pg.cells, ...p.ch.cells].filter((c) => c.hit !== null).map((c) => c.r));
        expect(found.size, `${preset.id} ${id}`).toBeGreaterThan(0);
        expect(found.size, `${preset.id} ${id}`).toBeLessThan(p.rows.length);
      }
    }
  });
});

describe('plan', () => {
  it('draws the slower engine in 3 s and the faster in its share', () => {
    const p = plan(SCENES['revenue-by-category'], result('revenue-by-category', engine(100), engine(25), 'ch'), BASELINE, STANDARD);
    expect(p.pg.d).toBe(SLOW_MS);
    expect(p.ch.d).toBe(SLOW_MS / 4);
    expect(p.note).toBeNull();
  });

  it('holds the faster engine at a minimum and says the real gap is wider', () => {
    const p = plan(SCENES['revenue-by-category'], result('revenue-by-category', engine(200), engine(10), 'ch'), BASELINE, STANDARD);
    expect(p.ch.d).toBe(MIN_MS);
    expect(p.note).toBe('The real gap is 20×, wider than drawn.');
  });

  it('finishes a tie together', () => {
    const p = plan(SCENES['email-city-search'], result('email-city-search', engine(5), engine(5.2), null), BASELINE, STANDARD);
    expect(p.pg.d).toBe(SLOW_MS);
    expect(p.ch.d).toBe(SLOW_MS);
  });

  it('spends the start of the drawing on each engine’s fixed cost, at most 80%', () => {
    const p = plan(SCENES['user-by-id'], result('user-by-id', engine(3), engine(3.5), null), BASELINE, STANDARD);
    expect(p.pg.wait).toBeCloseTo(SLOW_MS * 0.1);
    expect(p.ch.wait).toBeCloseTo(SLOW_MS * 0.8);
    expect(Math.min(...p.ch.cells.map((c) => c.at))).toBe(Math.round(LEAD_MS + p.ch.wait));
  });

  it('lights cells in order, all within the drawing, and darkens them no earlier', () => {
    for (const [id, scene] of Object.entries(SCENES)) {
      for (const narrow of [false, true]) {
        const p = plan(scene, result(id, engine(90), engine(30), 'ch'), BASELINE, STANDARD, narrow);
        for (const side of [p.pg, p.ch]) {
          const at = side.cells.map((c) => c.at);
          expect(at, id).toEqual([...at].sort((a, b) => a - b));
          expect(Math.max(...at), id).toBeLessThan(LEAD_MS + side.d);
          for (const cell of side.cells) if (cell.hit !== null) expect(cell.hit).toBeGreaterThanOrEqual(cell.at);
          // Each cell lights once.
          expect(new Set(side.cells.map((c) => `${c.r}-${c.c}`)).size, id).toBe(side.cells.length);
        }
      }
    }
  });

  it('shows real values, one cell per column', () => {
    const p = plan(SCENES['order-by-id'], result('order-by-id', engine(1), engine(15), 'pg'), BASELINE, STANDARD);
    expect(p.columns.map((c) => c.name)).toEqual(TABLES.find((t) => t.name === 'orders')!.columns.map((c) => c.name));
    expect(p.rows[1].map((v) => v.text)).toEqual(['242424', '96725', '2024-08-21 14:44:23', 'electronics', '2', '15199', 'completed', 'apple_pay']);
    for (const r of p.rows) expect(r).toHaveLength(p.columns.length);
  });

  describe('a scan', () => {
    const p = plan(SCENES['revenue-by-category'], result('revenue-by-category', engine(100), engine(25), 'ch'), BASELINE, STANDARD);
    const col = (name: string) => p.columns.findIndex((c) => c.name === name);

    it('has Postgres read whole rows and ClickHouse only its columns, filter first', () => {
      expect(p.pg.cells).toHaveLength(8 * 8);
      expect(p.pg.cells.slice(0, 8).every((c) => c.r === 0)).toBe(true);
      expect(p.ch.cells).toHaveLength(8 * 4);
      expect(p.ch.cells.slice(0, 8).every((c) => c.c === col('status'))).toBe(true);
      expect(new Set(p.ch.cells.map((c) => p.columns[c.c].name))).toEqual(new Set(['status', 'category', 'quantity', 'price_cents']));
      expect(p.pg.skipped).toEqual([]);
      expect(p.ch.skipped).toEqual([]);
      expect(p.pg.caption).toBe('Reads every row, all 8 columns.');
      expect(p.ch.caption).toBe('Reads every row, but only 4 of 8 columns, compressed.');
    });

    it('darkens only the needed cells of the rows that pass', () => {
      // Rows 3 and 7 are cancelled and shipped.
      for (const side of [p.pg, p.ch]) {
        expect(side.cells.filter((c) => c.r === 3 || c.r === 7).every((c) => c.hit === null)).toBe(true);
        expect(side.cells.filter((c) => c.r === 0 && c.c === col('category'))[0].hit).not.toBeNull();
      }
      expect(column(p.pg, col('payment_method')).every((c) => c.hit === null)).toBe(true);
      // Postgres only knows a row passes once it reaches status, after category.
      const r0 = row(p.pg, 0);
      const status = r0.find((c) => c.c === col('status'))!;
      expect(r0.find((c) => c.c === col('category'))!.hit).toBe(status.at);
      // ClickHouse read status first, so it knows by the time it reads category.
      const category = row(p.ch, 0).find((c) => c.c === col('category'))!;
      expect(category.hit).toBe(category.at);
    });
  });

  it('skips the rows outside a time range on both', () => {
    const p = plan(SCENES['daily-orders'], result('daily-orders', engine(40), engine(8), 'ch'), BASELINE, STANDARD);
    expect(rowsOf(p.pg)).toEqual([4, 5]);
    expect(p.pg.skipped).toEqual([0, 1, 2, 3, 6, 7]);
    expect(rowsOf(p.ch)).toEqual([4, 5]);
    expect(p.ch.skipped).toEqual(p.pg.skipped);
    expect(p.pg.caption).toBe('Skips to Mar–May 2025, then reads whole rows.');
    expect(p.ch.caption).toBe('Skips to Mar–May 2025, then reads 3 of 8 columns.');
  });

  it('puts ClickHouse’s start-up first when Postgres wins a short range', () => {
    const p = plan(SCENES['last-five-minutes'], result('last-five-minutes', engine(0.5), engine(4), 'pg'), BASELINE, STANDARD);
    expect(rowsOf(p.pg)).toEqual([7]);
    expect(rowsOf(p.ch)).toEqual([7]);
    expect(p.pg.caption).toBe('Skips to the last 5 minutes of 2025, then reads whole rows.');
    expect(p.ch.caption).toBe('Spends about 3.0 ms starting up, then skips to the last 5 minutes of 2025 and reads 4 of 8 columns.');
  });

  describe('a lookup', () => {
    it('has Postgres jump to the row and ClickHouse scan the key column first', () => {
      const p = plan(SCENES['order-by-id'], result('order-by-id', engine(0.5), engine(15), 'pg'), BASELINE, STANDARD);
      expect(p.pg.cells).toHaveLength(8);
      expect(p.pg.cells.every((c) => c.r === 1 && c.hit === c.at)).toBe(true);
      expect(p.pg.skipped).toEqual([0, 2, 3, 4, 5, 6, 7]);
      const scan = p.ch.cells.slice(0, 8);
      expect(scan.every((c) => c.c === 0)).toBe(true);
      expect(scan.filter((c) => c.hit !== null).map((c) => c.r)).toEqual([1]);
      // The found row's other columns arrive together, after the scan.
      const rest = p.ch.cells.slice(8);
      expect(rest).toHaveLength(7);
      expect(rest.every((c) => c.r === 1 && c.hit === c.at)).toBe(true);
      expect(new Set(rest.map((c) => c.at)).size).toBe(1);
      expect(rest[0].at).toBeGreaterThan(Math.max(...scan.map((c) => c.at)));
      expect(p.ch.skipped).toEqual([]);
      expect(p.pg.caption).toBe('Its index on id jumps straight to the row.');
      expect(p.ch.caption).toBe('Sorted by time, not id, so it scans the id column.');
    });

    it('finds every row of a customer, and leaves the columns it doesn’t need light', () => {
      const p = plan(SCENES['customer-last-orders'], result('customer-last-orders', engine(0.5), engine(15), 'pg'), BASELINE, STANDARD);
      expect(rowsOf(p.pg)).toEqual([2, 6]);
      expect(p.pg.cells.filter((c) => c.c === 7).every((c) => c.hit === null)).toBe(true);
      expect(p.ch.cells.filter((c) => c.c === 1)).toHaveLength(8);
      expect(p.ch.cells.filter((c) => c.c !== 1)).toHaveLength(2 * 6);
      expect(p.pg.caption).toBe('Its index on user_id jumps straight to the rows.');
      expect(p.ch.caption).toBe('Sorted by time, not user_id, so it scans the user_id column.');
    });

    it('says ClickHouse reads one block when it’s sorted by the key', () => {
      const p = plan(SCENES['user-by-id'], result('user-by-id', engine(0.2), engine(3), 'pg'), BASELINE, STANDARD);
      expect(rowsOf(p.pg)).toEqual([4]);
      expect(p.pg.caption).toBe('Its index on id jumps straight to the row.');
      expect(p.ch.caption).toBe('Spends about 3.0 ms starting up; its index on id narrows it to one block of 8,192 rows.');
    });
  });

  describe('a top N', () => {
    const p = plan(SCENES['newest-orders'], result('newest-orders', engine(0.3), engine(12), 'pg'), BASELINE, STANDARD);

    it('has Postgres read only the newest rows and ClickHouse every id first', () => {
      expect(rowsOf(p.pg)).toEqual([7]);
      expect(p.pg.skipped).toEqual([0, 1, 2, 3, 4, 5, 6]);
      const scan = p.ch.cells.slice(0, 8);
      expect(scan.every((c) => c.c === 0)).toBe(true);
      expect(scan.filter((c) => c.hit !== null).map((c) => c.r)).toEqual([7]);
      // The newest row's other selected columns, not payment_method.
      const rest = p.ch.cells.slice(8);
      expect(rest).toHaveLength(6);
      expect(rest.every((c) => c.r === 7 && p.columns[c.c].name !== 'payment_method')).toBe(true);
      expect(p.pg.caption).toBe('Walks its index on id from the end and stops after 20 rows.');
      expect(p.ch.caption).toBe('Sorted by time, not id, so it reads every id to find the top 20.');
    });

    it('counts the newest rows from the size measured on', () => {
      const light = plan(SCENES['newest-orders'], result('newest-orders', engine(0.3), engine(12), 'pg'), BASELINE, { preset: 'light', users: 50_000, orders: 250_000 });
      expect(rowsOf(light.pg)).toEqual([7]);
    });
  });

  describe('a search', () => {
    const cols = ['id', 'first_name', 'last_name', 'email', 'city'];
    const fifty = Array.from({ length: 50 }, (_, i) => [i * 80 + 1, 'a', 'b', 'c', 'd']);
    const withStats = (rowsRead: number | null) => ({ ...engine(4, cols, fifty), chStats: { elapsedMs: null, rowsRead, bytesRead: null } });
    const search = (pg: EngineResult, ch: EngineResult, narrow = false) =>
      plan(SCENES['email-city-search'], result('email-city-search', pg, ch, 'pg'), BASELINE, STANDARD, narrow);
    const p = search(engine(1.2, cols, fifty), withStats(16_384));
    const col = (name: string) => p.columns.findIndex((c) => c.name === name);

    it('marks what each term matched', () => {
      expect(p.rows[4][col('email')]).toEqual({ text: 'ryan.henderson52@gmail.com', mark: [11, 14] });
      expect(p.rows[4][col('city')]).toEqual({ text: 'San Diego', mark: [0, 3] });
      // Each of these matches only one term.
      expect(p.rows[2][col('email')].mark).toEqual([12, 15]);
      expect(p.rows[2][col('city')].mark).toBeUndefined();
      expect(p.rows[3][col('email')].mark).toBeUndefined();
      expect(p.rows[3][col('city')].mark).toEqual([0, 3]);
      expect(p.rows[0][col('id')].mark).toBeUndefined();
    });

    it('has Postgres read whole rows, knowing a match at its city', () => {
      expect(p.pg.cells).toHaveLength(6 * p.columns.length);
      expect(p.pg.cells.filter((c) => c.hit !== null).every((c) => c.r === 4 || c.r === 5)).toBe(true);
      const city = row(p.pg, 4).find((c) => c.c === col('city'))!;
      expect(row(p.pg, 4).find((c) => c.c === col('id'))!.hit).toBe(city.at);
      expect(row(p.pg, 4).find((c) => c.c === col('country'))!.hit).toBeNull();
    });

    it('has ClickHouse read its columns, then the names of the matches', () => {
      const read = p.ch.cells.slice(0, 18);
      expect([...new Set(read.map((c) => p.columns[c.c].name))]).toEqual(['email', 'city', 'id']);
      const rest = p.ch.cells.slice(18);
      expect(rest.map((c) => [c.r, p.columns[c.c].name])).toEqual([
        [4, 'first_name'],
        [4, 'last_name'],
        [5, 'first_name'],
        [5, 'last_name'],
      ]);
      expect(rest.every((c) => c.hit === c.at)).toBe(true);
    });

    it('says both stop at the 50th match when they find 50', () => {
      expect(p.pg.caption).toBe('Walks rows in id order and stops at the 50th match.');
      expect(p.ch.caption).toBe('Spends about 3.0 ms starting up, then reads 3 of 9 columns in id order, also stopping at the 50th match.');
    });

    it('says ClickHouse read every row when its own count says so', () => {
      const all = search(engine(1.2, cols, fifty), withStats(108_192));
      expect(all.pg.caption).toBe('Walks rows in id order and stops at the 50th match.');
      expect(all.ch.caption).toBe('Spends about 3.0 ms starting up, then reads 3 of 9 columns of every row.');
    });

    it('says both read the whole table when they find fewer than 50', () => {
      const few = search(engine(3, cols, [[7, 'a', 'b', 'c', 'd']]), engine(4, cols, []));
      expect(few.pg.caption).toBe('Walks every row in id order, all 9 columns.');
      expect(few.ch.caption).toMatch(/of every row\.$/);
    });

    it('folds the names into one column on a narrow table', () => {
      const n = search(engine(1.2, cols, fifty), withStats(16_384), true);
      expect(n.columns.map((c) => c.name)).toEqual(['id', 'email', 'city', '+6']);
      expect(n.columns[3]).toMatchObject({ used: true, more: ['first_name', 'last_name', 'country', 'signup_date', 'birth_year', 'plan'] });
      expect(n.rows[0][3]).toEqual({ text: '…' });
      expect(n.ch.cells.slice(18).map((c) => [c.r, c.c])).toEqual([
        [4, 3],
        [5, 3],
      ]);
    });
  });

  describe('a narrow table', () => {
    const p = plan(SCENES['revenue-by-category'], result('revenue-by-category', engine(100), engine(25), 'ch'), BASELINE, STANDARD, true);

    it('folds the columns it leaves out into "+N", needed or not', () => {
      expect(p.columns.map((c) => c.name)).toEqual(['category', 'quantity', 'price_cents', 'status', '+4']);
      expect(p.columns[4]).toMatchObject({ used: false, more: ['id', 'user_id', 'created_at', 'payment_method'] });
    });

    it('has Postgres read the folded columns last in each row', () => {
      expect(row(p.pg, 0).map((c) => c.c)).toEqual([0, 1, 2, 3, 4]);
      expect(p.ch.cells.every((c) => c.c !== 4)).toBe(true);
    });

    it('sizes headers by their longest part, since they wrap at underscores', () => {
      const wide = plan(SCENES['revenue-by-category'], result('revenue-by-category', engine(100), engine(25), 'ch'), BASELINE, STANDARD);
      expect(wide.columns.find((c) => c.name === 'price_cents')!.width).toBe('price_cents'.length);
      expect(p.columns.find((c) => c.name === 'price_cents')!.width).toBe('price_'.length);
    });
  });

  it('adds the scene’s note after the gap note', () => {
    const p = plan(SCENES['price-percentiles'], result('price-percentiles', engine(400), engine(20), 'ch'), BASELINE, STANDARD);
    expect(p.note).toBe('The real gap is 20×, wider than drawn. Not drawn: Postgres then sorts each category’s prices in one process.');
  });
});
