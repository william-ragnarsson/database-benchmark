// The contract between the server and the page. Both sides import this file.

export type Engine = 'pg' | 'ch';
export type PresetId = 'light' | 'standard' | 'large';
export type LifecycleState = 'starting' | 'empty' | 'incomplete' | 'seeding' | 'deleting' | 'ready' | 'error';
export type JobKind = 'seed' | 'delete' | 'run' | 'suite' | 'explain' | 'browse';

export interface Preset {
  id: PresetId;
  label: string;
  orders: number;
  users: number;
  estDiskMB: number;
  estSeedSec: number;
  note: string;
  warning?: string;
}

export interface Meta {
  preset: PresetId;
  seed: number;
  generatorVersion: number;
  seededAt: string;
  orders: number;
  users: number;
}

export interface EngineSizes {
  totalBytes: number;
  benchBytes: number;
  overheadBytes: number;
  tables: Record<string, number>;
}

export interface Sizes {
  pg: EngineSizes | null;
  ch: EngineSizes | null;
  measuredAt: string;
}

export type SeedPhase = 'deleting' | 'loading' | 'indexing' | 'verifying' | 'warming' | 'done';

export interface EngineProgress {
  step: string;
  rowsDone: number;
  rowsTotal: number;
  bytesDone: number;
  done: boolean;
}

export interface SeedProgress {
  kind: 'seed' | 'delete';
  preset: PresetId | null;
  phase: SeedPhase;
  startedAt: string;
  engines: Record<Engine, EngineProgress>;
  etaSec: number | null;
}

export interface Status {
  state: LifecycleState;
  meta: Meta | null;
  sizes: Sizes | null;
  progress: SeedProgress | null;
  busy: { kind: JobKind; since: string } | null;
  error: { message: string; job: 'seed' | 'delete' | 'boot'; preset: PresetId | null } | null;
  incompleteReason: string | null;
  lastFreedBytes: number | null;
  baselineMs: Record<Engine, number> | null;
  presets: Preset[];
}

// ---- Running queries ----

export interface RunRequest {
  pg: string;
  ch: string;
  runs: 1 | 3 | 5;
  templateId?: string;
}

export type EngineStatus = 'ok' | 'timeout' | 'error' | 'cancelled';

export interface ChStats {
  elapsedMs: number | null;
  rowsRead: number | null;
  bytesRead: number | null;
}

export interface EngineResult {
  status: EngineStatus;
  warmupMs: number | null;
  runsMs: number[];
  medianMs: number | null;
  slow: boolean;
  columns: string[];
  types: string[];
  rows: unknown[][];
  truncated: boolean;
  error: string | null;
  hint: string | null;
  chStats: ChStats | null;
}

export interface Headline {
  text: string;
  winner: Engine | null;
  ratio: number | null;
  lowerBound: boolean;
  instant: boolean;
}

export type MatchKind = 'match' | 'not-comparable' | 'mismatch' | 'not-compared';

export interface MatchResult {
  kind: MatchKind;
  detail: string | null;
  hint: string | null;
}

export interface RunResult {
  runId: string;
  templateId: string | null;
  engines: Record<Engine, EngineResult>;
  headline: Headline;
  match: MatchResult;
  truncationHint: boolean;
  totalMs: number;
}

export type RunEvent =
  | { type: 'start'; runId: string; runs: number }
  // runs: how many measured runs this engine will get (1 after a slow warm-up, 0 after a failure).
  | { type: 'warmup'; engine: Engine; ms: number | null; status: EngineStatus; runs: number }
  | { type: 'run'; engine: Engine; index: number; ms: number }
  | { type: 'done'; result: RunResult }
  | { type: 'error'; message: string };

export interface SuiteItem {
  templateId: string;
  title: string;
  expectedWinner: 'pg' | 'ch' | 'tie';
  pgMs: number | null;
  chMs: number | null;
  headline: Headline;
  match: MatchKind;
  failed: boolean;
}

export interface SuiteSummary {
  geomeanRatio: number | null;
  winner: Engine | null;
  text: string;
  pgTotalMs: number;
  chTotalMs: number;
  failed: string[];
}

export type SuiteEvent =
  | { type: 'start'; runId: string; total: number }
  | { type: 'template-start'; templateId: string; index: number }
  | { type: 'template-done'; item: SuiteItem; index: number }
  | { type: 'done'; items: SuiteItem[]; summary: SuiteSummary }
  | { type: 'error'; message: string };

export interface ExplainRequest {
  engine: Engine;
  sql: string;
}

export interface ExplainResponse {
  engine: Engine;
  plan: string;
  error: string | null;
}

export interface RowsPage {
  columns: string[];
  rows: unknown[][];
}

// One page of a table, read from both engines so the page can show they hold the same rows.
export interface RowsResponse {
  table: string;
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  pg: RowsPage;
  ch: RowsPage;
}

export interface ApiError {
  error: string;
  busy?: { kind: JobKind; since: string } | null;
}
