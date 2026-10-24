import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readRows } from '../src/client/demo/rows';
import type { DemoIndex, DemoPreset } from '../src/client/demo/format';
import { PRESETS } from '../src/shared/presets';
import { TEMPLATES, templateSql } from '../src/shared/templates';
import type { PresetId } from '../src/shared/types';

// The demo build (scripts/record-demo.ts) replays recordings and makes its table rows in the page.

type Fixture = Record<string, { users: number; orders: number; pages: Record<'users' | 'orders', { page: number; rows: unknown[][] }[]> }>;

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const recording = (preset: PresetId) => read<DemoPreset>(`../src/client/demo/recordings/${preset}.json`);
const fixture = read<Fixture>('./fixtures/demo-rows.json');
const recordedSql = read<Record<string, { pg: string; ch: string }>>('./fixtures/demo-sql.json');

describe('demo rows', () => {
  for (const preset of Object.keys(fixture) as PresetId[]) {
    it(`match the ${preset} pages a real stack returned`, () => {
      const meta = recording(preset).status.meta!;
      expect([meta.users, meta.orders]).toEqual([fixture[preset].users, fixture[preset].orders]);
      for (const table of ['users', 'orders'] as const) {
        for (const { page, rows } of fixture[preset].pages[table]) {
          expect(readRows(meta, table, page, 20).pg.rows, `${table} page ${page}`).toEqual(rows);
        }
      }
    });
  }
});

describe('demo recordings', () => {
  it('cover every size', () => {
    const index = read<DemoIndex>('../src/client/demo/recordings/index.json');
    // The demo shows the sizes as they were recorded. A size changed since: record again.
    expect(index.presets).toEqual(PRESETS);
    expect(Object.keys(fixture).sort()).toEqual(PRESETS.map((p) => p.id).sort());
  });

  // A query added since the recording can't be replayed: record again.
  for (const preset of PRESETS.map((p) => p.id)) {
    it(`have every current query on ${preset}, finished`, () => {
      const rec = recording(preset);
      expect(rec.status.meta?.preset).toBe(preset);
      // Sizes taken sooner still count the parts ClickHouse's merges replaced (CLEANUP_MS in the recorder).
      const sinceReady = Date.parse(rec.status.sizes!.measuredAt) - Date.parse(rec.status.meta!.seededAt);
      expect(sinceReady, 'ms from ready to the sizes').toBeGreaterThanOrEqual(30_000);
      for (const t of TEMPLATES) {
        const events = rec.runs[t.id];
        expect(events, t.id).toBeDefined();
        expect(events.at(-1)![1].type, t.id).toBe('done');
      }
    });
  }

  // A query changed since the recording replays its old timings. Rebuild the stack
  // (docker compose up --build), so it runs the new SQL, and record again.
  it('ran the current SQL of every query', () => {
    for (const t of TEMPLATES) expect(recordedSql[t.id], t.id).toEqual(templateSql(t));
  });
});
