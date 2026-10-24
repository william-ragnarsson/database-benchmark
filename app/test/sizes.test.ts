import { expect, it, vi } from 'vitest';
import { getSizes } from '../src/server/seed/sizes';

// Each Postgres size query answers, once released, with how many had started by then.
const { release } = vi.hoisted(() => ({ release: [] as (() => void)[] }));
vi.mock('../src/server/db', () => ({
  pgAdmin: {
    query: () =>
      new Promise((resolve) => {
        const n = release.length + 1;
        release.push(() => resolve({ rows: [{ db: String(n), wal: '0' }] }));
      }),
  },
  pgBench: () => ({ query: async () => ({ rows: [] }) }),
  chAdmin: { query: async () => ({ json: async () => [] }) },
}));

// A delete's freed bytes come from a forced measure taken once it is done. A poll's measure
// that started earlier, before the new database existed, mustn't stand in for it.
it('joins a measure already running, unless forced', async () => {
  const polled = getSizes(true);
  const joined = getSizes(true);
  const forced = getSizes(true, true);
  await vi.waitFor(() => expect(release).toHaveLength(1));
  release[0]();
  expect((await polled)?.pg?.totalBytes).toBe(1);
  expect((await joined)?.pg?.totalBytes).toBe(1);
  // The forced one starts only after the first is done.
  await vi.waitFor(() => expect(release).toHaveLength(2));
  release[1]();
  expect((await forced)?.pg?.totalBytes).toBe(2);
  // And is what later polls get.
  expect((await getSizes(true))?.pg?.totalBytes).toBe(2);
  expect(release).toHaveLength(2);
});
