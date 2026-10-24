import { describe, expect, it } from 'vitest';
import { formatRatio, geomean, headline, median, speedText } from '../src/server/bench/stats';
import { summarise } from '../src/server/bench/runner';
import type { EngineResult, SuiteItem } from '../src/shared/types';

function result(over: Partial<EngineResult>): EngineResult {
  return {
    status: 'ok', warmupMs: 10, runsMs: [], medianMs: 10, slow: false, columns: [], types: [],
    rows: [], truncated: false, error: null, hint: null, chStats: null, ...over,
  };
}

describe('median', () => {
  it('handles odd, even and empty lists without changing the input', () => {
    const xs = [5, 1, 3];
    expect(median(xs)).toBe(3);
    expect(xs).toEqual([5, 1, 3]);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });
});

describe('geomean', () => {
  it('is the geometric mean of the positive, finite values', () => {
    expect(geomean([2, 8])).toBeCloseTo(4);
    expect(geomean([10, 0.1])).toBeCloseTo(1);
    expect(geomean([4, 0, -1, Infinity, NaN])).toBeCloseTo(4);
    expect(geomean([])).toBeNull();
    expect(geomean([0])).toBeNull();
  });
});

describe('formatRatio', () => {
  it('uses one decimal below 10 and whole numbers from 10', () => {
    expect(formatRatio(1.234)).toBe('1.2×');
    expect(formatRatio(9.94)).toBe('9.9×');
    expect(formatRatio(9.97)).toBe('10×');
    expect(formatRatio(17.4)).toBe('17×');
  });
});

describe('speedText', () => {
  it('names the faster engine, or calls it a tie under 1.1×', () => {
    expect(speedText(2)).toMatchObject({ text: 'ClickHouse 2.0× faster', winner: 'ch', ratio: 2 });
    expect(speedText(0.25)).toMatchObject({ text: 'Postgres 4.0× faster', winner: 'pg', ratio: 4 });
    expect(speedText(1.05)).toMatchObject({ text: 'Roughly the same speed', winner: null });
    expect(speedText(1 / 1.05).winner).toBeNull();
    expect(speedText(3, ' overall').text).toBe('ClickHouse 3.0× faster overall');
  });
});

describe('headline', () => {
  it('is the ratio of the medians', () => {
    const h = headline(result({ medianMs: 170 }), result({ medianMs: 10 }));
    expect(h).toMatchObject({ text: 'ClickHouse 17× faster', winner: 'ch', ratio: 17, lowerBound: false, instant: false });
  });

  it('adds a qualifier, not a replacement, when both are under 10 ms', () => {
    const h = headline(result({ medianMs: 0.4 }), result({ medianMs: 6 }));
    expect(h.text).toBe('Postgres 15× faster · both feel instant (<10 ms)');
    expect(h.winner).toBe('pg');
    expect(h.instant).toBe(true);
  });

  it('gives a lower bound when one engine timed out', () => {
    const h = headline(result({ status: 'timeout', medianMs: null, warmupMs: 30_000 }), result({ medianMs: 250 }));
    expect(h).toMatchObject({ text: 'ClickHouse at least 120× faster', winner: 'ch', ratio: 120, lowerBound: true });
  });

  it('gives no ratio when an engine errored, both timed out or the run was cancelled', () => {
    const err = headline(result({ medianMs: 5 }), result({ status: 'error', medianMs: null }));
    expect(err).toMatchObject({ text: 'ClickHouse returned an error', winner: null, ratio: null });
    expect(headline(result({ status: 'error' }), result({ status: 'error' })).text).toBe('Postgres and ClickHouse returned an error');
    expect(headline(result({ status: 'timeout' }), result({ status: 'timeout' })).text).toBe('Both timed out (> 30 s)');
    expect(headline(result({ status: 'cancelled' }), result({})).text).toBe('Cancelled');
  });
});

describe('summarise (suite)', () => {
  const item = (templateId: string, pgMs: number | null, chMs: number | null, failed = false) =>
    ({ templateId, pgMs, chMs, failed }) as SuiteItem;

  it('takes the geometric mean of the ratios and leaves failed templates out', () => {
    const s = summarise([item('a', 100, 10), item('b', 1, 10), item('c', 40, 4), item('d', null, 5, true)]);
    expect(s.geomeanRatio).toBeCloseTo(Math.cbrt(10 * 0.1 * 10));
    expect(s.winner).toBe('ch');
    expect(s.text).toBe('ClickHouse 2.2× faster overall');
    expect(s.pgTotalMs).toBe(141);
    expect(s.chTotalMs).toBe(24);
    expect(s.failed).toEqual(['d']);
  });

  it('says how far a cancelled suite got', () => {
    expect(summarise([item('a', 100, 10)], true).text).toMatch(/^Cancelled after 1 of \d+$/);
  });
});
