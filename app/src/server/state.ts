// The lifecycle state the page sees, and the one global job lock. Seeding, deleting, a run
// and a suite each hold the lock, so the engines never do two things at once.

import type { Engine, JobKind, LifecycleState, Meta, SeedProgress, Status } from '../shared/types';

export const app: {
  state: LifecycleState;
  meta: Meta | null;
  progress: SeedProgress | null;
  error: Status['error'];
  incompleteReason: string | null;
  lastFreedBytes: number | null;
  baselineMs: Record<Engine, number> | null;
} = {
  state: 'starting',
  meta: null,
  progress: null,
  error: null,
  incompleteReason: null,
  lastFreedBytes: null,
  baselineMs: null,
};

type Busy = { kind: JobKind; since: string };
let busy: Busy | null = null;

export function getBusy(): Busy | null {
  return busy;
}

// Returns a release function, or null if another job holds the lock.
export function tryLock(kind: JobKind): (() => void) | null {
  if (busy) return null;
  const mine: Busy = { kind, since: new Date().toISOString() };
  busy = mine;
  return () => {
    if (busy === mine) busy = null;
  };
}

export function setState(state: LifecycleState, extra: Partial<Omit<typeof app, 'state'>> = {}): void {
  Object.assign(app, { state, ...extra });
}
