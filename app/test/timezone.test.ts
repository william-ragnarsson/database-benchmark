// Runs in its own file (vitest gives each file its own process), so the time zone can't leak
// into the other tests. Proves that dates don't shift when the server runs outside UTC.
process.env.TZ = 'Europe/Stockholm';

import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { compareResults, normalise } from '../src/server/bench/compare';
import { prepare } from '../src/server/bench/guard';
import { readerTypes } from '../src/server/db';

describe('outside UTC (Europe/Stockholm)', () => {
  it('really is running in Stockholm time', () => {
    expect(new Date(Date.UTC(2025, 6, 1)).getTimezoneOffset()).toBe(-120);
    expect(new Date(Date.UTC(2025, 0, 1)).getTimezoneOffset()).toBe(-60);
  });

  it('keeps Postgres dates and timestamps as the text Postgres sent', () => {
    for (const [oid, text] of [[1082, '2025-03-01'], [1114, '2025-03-01 00:30:00'], [1184, '2025-03-01 00:30:00+00'], [1186, '1 day']] as const) {
      expect(readerTypes.getTypeParser(oid, 'text')(text)).toBe(text);
    }
    // Arrays of them (date[] and timestamptz[]) become arrays of that text.
    const parseArray = (oid: number, text: string) => readerTypes.getTypeParser(oid, 'text')(text);
    expect(parseArray(1182, '{2025-03-01,2025-03-02}')).toEqual(['2025-03-01', '2025-03-02']);
    expect(parseArray(1185, '{"2025-03-01 00:30:00+00"}')).toEqual(['2025-03-01 00:30:00+00']);
    // The default parser would have read the date as local midnight, a day early in UTC.
    expect((pg.types.getTypeParser(1082, 'text')('2025-03-01') as Date).toISOString()).toBe('2025-02-28T23:00:00.000Z');
  });

  it('normalises dates, offsets and Date objects to the same UTC text', () => {
    expect(normalise('2025-03-01')).toBe('2025-03-01 00:00:00');
    expect(normalise('2025-07-01 00:30:00+02')).toBe('2025-06-30 22:30:00');
    expect(normalise(new Date(Date.UTC(2025, 2, 1)))).toBe('2025-03-01 00:00:00');
  });

  it('matches a Postgres date column against the ClickHouse Date', () => {
    const sql = 'SELECT CAST(created_at AS DATE) AS day FROM orders GROUP BY day';
    const parse = readerTypes.getTypeParser(1082, 'text');
    const r = compareResults(
      { columns: ['day'], types: ['date'], rows: [[parse('2025-03-01')], [parse('2025-03-02')]], truncated: false },
      { columns: ['day'], types: ['Date'], rows: [['2025-03-02'], ['2025-03-01']], truncated: false },
      { pg: prepare(sql, 'pg'), ch: prepare(sql, 'ch'), raw: sql },
    );
    expect(r.kind).toBe('match');
  });
});
