// Medians, ratios and the headline sentence. Pure functions, shared by runs and the suite.

import type { Engine, EngineResult, Headline } from '../../shared/types';

// Both medians under this get "both feel instant". ClickHouse's own fixed cost is ~2.5 ms, so its
// fastest lookups land at 5–8 ms.
export const INSTANT_MS = 10;
// Below this ratio the two are called a tie rather than "1.05× faster".
const TIE_RATIO = 1.1;

export const ENGINE_NAMES: Record<Engine, string> = { pg: 'Postgres', ch: 'ClickHouse' };

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function geomean(xs: number[]): number | null {
  const ok = xs.filter((x) => x > 0 && Number.isFinite(x));
  if (!ok.length) return null;
  return Math.exp(ok.reduce((a, x) => a + Math.log(x), 0) / ok.length);
}

export function formatRatio(r: number): string {
  // 9.95 and up would print as "10.0×".
  return r >= 9.95 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`;
}

// pg / ch: above 1 means ClickHouse was faster.
export function speedText(pgOverCh: number, suffix = ''): { text: string; winner: Engine | null; ratio: number } {
  const winner: Engine = pgOverCh >= 1 ? 'ch' : 'pg';
  const ratio = pgOverCh >= 1 ? pgOverCh : 1 / pgOverCh;
  if (ratio < TIE_RATIO) return { text: `Roughly the same speed${suffix}`, winner: null, ratio };
  return { text: `${ENGINE_NAMES[winner]} ${formatRatio(ratio)} faster${suffix}`, winner, ratio };
}

export function headline(pg: EngineResult, ch: EngineResult): Headline {
  const none = (text: string): Headline => ({ text, winner: null, ratio: null, lowerBound: false, instant: false });
  if (pg.status === 'cancelled' || ch.status === 'cancelled') return none('Cancelled');
  if (pg.status === 'error' || ch.status === 'error') {
    const failed = [pg.status === 'error' && 'Postgres', ch.status === 'error' && 'ClickHouse'].filter(Boolean).join(' and ');
    return none(`${failed} returned an error`);
  }
  if (pg.status === 'timeout' && ch.status === 'timeout') return none('Both timed out (> 30 s)');

  // One engine timed out: the other is at least (time until the timeout) / (its median) faster.
  if (pg.status === 'timeout' || ch.status === 'timeout') {
    const [slow, fast, winner]: [EngineResult, EngineResult, Engine] = pg.status === 'timeout' ? [pg, ch, 'ch'] : [ch, pg, 'pg'];
    const ratio = (slow.warmupMs ?? 30_000) / Math.max(fast.medianMs ?? 1, 0.01);
    return { text: `${ENGINE_NAMES[winner]} at least ${formatRatio(ratio)} faster`, winner, ratio, lowerBound: true, instant: false };
  }

  if (pg.medianMs == null || ch.medianMs == null) return none('No result');
  const instant = pg.medianMs < INSTANT_MS && ch.medianMs < INSTANT_MS;
  const s = speedText(pg.medianMs / Math.max(ch.medianMs, 0.001), instant ? ` · both feel instant (<${INSTANT_MS} ms)` : '');
  return { ...s, lowerBound: false, instant };
}
