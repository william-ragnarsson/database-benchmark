// What scripts/record-demo.ts writes and the demo build replays. Times are milliseconds from
// the moment the action started.

import type { Meta, Preset, PresetId, RunEvent, SeedProgress, Sizes, Status } from '../../shared/types';

export type Timed<T> = [ms: number, value: T];

export interface Job {
  steps: Timed<Omit<SeedProgress, 'startedAt'>>[];
  // When the job was over: the first status poll that no longer showed it.
  ms: number;
}

// One dataset size: generating it, and every query run on it.
export interface DemoPreset {
  preset: PresetId;
  seed: Job;
  status: { sizes: Sizes | null; baselineMs: Status['baselineMs']; meta: Meta | null };
  runs: Record<string, Timed<RunEvent>[]>;
}

export interface DemoIndex {
  recordedAt: string;
  machine: string;
  presets: Preset[];
  // Deleting Standard. Other sizes free their own size less what an empty stack still uses.
  delete: Job & { emptySizes: Sizes | null; freedBytes: number };
}
