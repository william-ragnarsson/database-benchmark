import { readStored, writeStored } from './hooks';
import type { Engine, EngineStatus, MatchKind, PresetId, RunResult } from '../shared/types';

// One finished run, kept in localStorage so the scoreboard survives a refresh.
export interface HistoryEntry {
  id: string;
  at: string;
  title: string | null;
  sql: Record<Engine, string>;
  separate: boolean;
  templateId: string | null;
  preset: PresetId | null;
  ms: Record<Engine, number | null>;
  statuses: Record<Engine, EngineStatus>;
  headline: string;
  winner: Engine | null;
  ratio: number | null;
  lowerBound: boolean;
  match: MatchKind;
}

export const HISTORY_KEY = 'pgch.history';
const MAX_ENTRIES = 50;

export function loadHistory(): HistoryEntry[] {
  const list = readStored<unknown>(HISTORY_KEY, []);
  return Array.isArray(list) ? (list as HistoryEntry[]).filter((e) => e && typeof e.id === 'string' && e.sql) : [];
}

// What the Run page knows about a run that the result itself doesn't carry.
export interface HistoryInfo {
  sql: Record<Engine, string>;
  separate: boolean;
  title: string | null;
  preset: PresetId | null;
}

// Builds on what's stored and on this tab's list, so two open tabs don't overwrite each other's
// runs, and the list still grows when the browser won't store anything.
export function addHistory(result: RunResult, info: HistoryInfo, current: HistoryEntry[]): HistoryEntry[] {
  const { engines, headline } = result;
  const entry: HistoryEntry = {
    id: result.runId,
    at: new Date().toISOString(),
    title: info.title,
    sql: info.sql,
    separate: info.separate,
    templateId: result.templateId,
    preset: info.preset,
    ms: { pg: engines.pg.medianMs, ch: engines.ch.medianMs },
    statuses: { pg: engines.pg.status, ch: engines.ch.status },
    headline: headline.text,
    winner: headline.winner,
    ratio: headline.ratio,
    lowerBound: headline.lowerBound,
    match: result.match.kind,
  };
  const byId = new Map<string, HistoryEntry>();
  for (const e of [entry, ...loadHistory(), ...current]) if (!byId.has(e.id)) byId.set(e.id, e);
  // Newest first; `at` is an ISO time, so it sorts as text.
  const next = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_ENTRIES);
  writeStored(HISTORY_KEY, next);
  return next;
}

export function clearHistory(): HistoryEntry[] {
  writeStored(HISTORY_KEY, []);
  return [];
}
