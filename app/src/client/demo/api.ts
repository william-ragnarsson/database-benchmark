// The demo build's stand-in for the server. Every query on every size was run once on a real
// stack (scripts/record-demo.ts); a run here replays that one's events at the pace they came.
// Generating and deleting replay their recorded progress. The dataset state is kept in
// localStorage, so it survives a reload and every tab sees the same one, as with a server.

import { RequestError, type Api } from '../api';
import type { JobKind, PresetId, RunEvent, Sizes, Status } from '../../shared/types';
import { DEFAULT_PRESET } from '../../shared/presets';
import type { DemoIndex, DemoPreset, Job } from './format';
import { readRows } from './rows';
import indexJson from './recordings/index.json';

// JSON imports are typed with plain strings; the file is what format.ts describes.
const index = indexJson as unknown as DemoIndex;

const recordings = import.meta.glob<DemoPreset>(['./recordings/*.json', '!./recordings/index.json'], { import: 'default', eager: true });
const recording = (preset: PresetId): DemoPreset | undefined => recordings[`./recordings/${preset}.json`];

// ---- dataset state ----

type DemoJob = { kind: 'seed'; preset: PresetId; t0: number } | { kind: 'delete'; t0: number; freed: number };

interface State {
  preset: PresetId | null;
  seededAt: string;
  lastFreedBytes: number | null;
  job: DemoJob | null;
}

const KEY = 'pgch.demo';
const initial = (): State => ({ preset: DEFAULT_PRESET, seededAt: index.recordedAt, lastFreedBytes: null, job: null });

// Kept in memory too: with storage blocked, the state lasts until the page is closed.
let memory = initial();

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) memory = { ...initial(), ...(JSON.parse(raw) as Partial<State>) };
  } catch {
    // Storage blocked or the value unreadable: keep what this page last had.
  }
  return memory;
}

function write(s: State): void {
  memory = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // See above.
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const totalBytes = (s: Sizes | null) => (s?.pg?.totalBytes ?? 0) + (s?.ch?.totalBytes ?? 0);

// Moves a job that has run its recorded length to its end state.
function settle(): State {
  const s = read();
  const job = s.job;
  if (!job) return s;
  const length = job.kind === 'seed' ? recording(job.preset)!.seed.ms : index.delete.ms;
  if (Date.now() - job.t0 < length) return s;
  const next: State =
    job.kind === 'seed'
      ? { preset: job.preset, seededAt: iso(job.t0 + length), lastFreedBytes: null, job: null }
      : { ...s, preset: null, lastFreedBytes: job.freed, job: null };
  write(next);
  return next;
}

// The recorded step a job is at now. A job's first poll can come before its first step.
function stepAt(job: Job, elapsed: number) {
  let step = job.steps[0];
  for (const s of job.steps) {
    if (s[0] > elapsed) break;
    step = s;
  }
  return step?.[1] ?? null;
}

async function status(): Promise<Status> {
  const s = settle();
  const rec = s.preset ? recording(s.preset)! : null;
  const base: Status = {
    state: rec ? 'ready' : 'empty',
    meta: rec?.status.meta ? { ...rec.status.meta, seededAt: s.seededAt } : null,
    sizes: rec ? rec.status.sizes : index.delete.emptySizes,
    progress: null,
    busy: null,
    error: null,
    incompleteReason: null,
    lastFreedBytes: s.lastFreedBytes,
    baselineMs: rec?.status.baselineMs ?? null,
    presets: index.presets,
  };
  const job = s.job;
  if (!job) return base;
  const elapsed = Date.now() - job.t0;
  const steps = job.kind === 'seed' ? recording(job.preset)!.seed : index.delete;
  const step = stepAt(steps, elapsed);
  return {
    ...base,
    state: job.kind === 'seed' ? 'seeding' : 'deleting',
    meta: null,
    baselineMs: null,
    lastFreedBytes: null,
    progress: step && { ...step, startedAt: iso(job.t0) },
    busy: { kind: job.kind, since: iso(job.t0) },
  };
}

const BUSY_TEXT: Record<DemoJob['kind'], string> = {
  seed: 'Data is being generated.',
  delete: 'Data is being deleted.',
};

// What the server answers when its one lock is taken.
function busy(job: DemoJob): RequestError {
  return new RequestError(BUSY_TEXT[job.kind], 409, { kind: job.kind as JobKind, since: iso(job.t0) });
}

async function seed(preset: PresetId): Promise<{ ok: true }> {
  const s = settle();
  if (s.job) throw busy(s.job);
  if (!recording(preset)) throw new RequestError('Unknown size preset.', 400);
  write({ ...s, lastFreedBytes: null, job: { kind: 'seed', preset, t0: Date.now() } });
  return { ok: true };
}

async function deleteAll(): Promise<{ ok: true }> {
  const s = settle();
  if (s.job) throw busy(s.job);
  // The recording deleted Standard. Another size frees its own size less what stays behind.
  const left = totalBytes(recording('standard')!.status.sizes) - index.delete.freedBytes;
  const freed = s.preset ? Math.max(0, totalBytes(recording(s.preset)!.status.sizes) - left) : 0;
  write({ ...s, lastFreedBytes: null, job: { kind: 'delete', t0: Date.now(), freed } });
  return { ok: true };
}

async function ready(): Promise<DemoPreset> {
  const s = settle();
  if (s.job) throw busy(s.job);
  if (!s.preset) throw new RequestError('The dataset is not ready yet.', 409);
  return recording(s.preset)!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Replays the recorded run of this query on the current size, each event at its recorded time.
async function run(body: { templateId?: string }, onEvent: (e: RunEvent) => void): Promise<void> {
  const rec = await ready();
  const events = body.templateId ? rec.runs[body.templateId] : undefined;
  if (!events) throw new RequestError('The demo can only replay the built-in queries.', 400);
  const runId = crypto.randomUUID();
  const t0 = performance.now();
  for (const [at, event] of events) {
    const wait = at - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
    if (event.type === 'start') onEvent({ ...event, runId });
    else if (event.type === 'done') onEvent({ ...event, result: { ...structuredClone(event.result), runId } });
    else onEvent(event);
  }
}

export const demoApi: Api = {
  status: () => status(),
  seed,
  deleteAll,
  recheck: async () => ({ ok: true }),
  rows: async (table, page, pageSize, signal) => {
    const rec = await ready();
    const s = read();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return readRows({ ...rec.status.meta!, seededAt: s.seededAt }, table as 'users' | 'orders', page, pageSize);
  },
  run,
};
