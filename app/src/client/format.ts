import type { Engine, Sizes } from '../shared/types';

export const ENGINE_LABEL: Record<Engine, string> = { pg: 'Postgres', ch: 'ClickHouse' };

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtRatio(r: number): string {
  return r >= 9.95 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`;
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
}

// Bytes a delete frees: the bench data, but not each engine's own empty-database files.
export function dataBytes(sizes: Sizes | null): number {
  return (sizes?.pg?.benchBytes ?? 0) + (sizes?.ch?.benchBytes ?? 0);
}
