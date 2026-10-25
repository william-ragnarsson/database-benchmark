import type { Preset, PresetId } from './types';

// Disk and seed-time figures are measured on Podman (4 CPUs per engine) after ClickHouse
// has removed its replaced parts. They include each engine's empty-database overhead.
export const PRESETS: Preset[] = [
  {
    id: 'light',
    label: 'Light',
    orders: 250_000,
    users: 50_000,
    estDiskMB: 75,
    estSeedSec: 4,
    note: 'ClickHouse wins the heavy queries 1.4–6×, but at 10–80 ms on Postgres everything still feels instant. Postgres wins the queries that touch only a few rows.',
  },
  {
    id: 'standard',
    label: 'Standard',
    orders: 1_000_000,
    users: 100_000,
    estDiskMB: 165,
    estSeedSec: 8,
    note: 'Heavy queries: Postgres ~20–400 ms vs ClickHouse ~9–40 ms (up to 13×). Postgres still wins the queries that touch only a few rows.',
  },
  {
    id: 'large',
    label: 'Large',
    orders: 5_000_000,
    users: 200_000,
    estDiskMB: 620,
    estSeedSec: 40,
    note: 'Heavy queries: Postgres ~0.1–3 s vs ClickHouse ~13–150 ms (up to 22×). The gap is plainly felt.',
    warning: 'Uses about 620 MB of disk (up to ~760 MB for a few seconds while loading), almost 4× the default size.',
  },
];

export const DEFAULT_PRESET: PresetId = 'standard';

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
