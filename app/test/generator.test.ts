import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_ROWS,
  OrderGenerator,
  hashKey,
  mulberry32,
  orderChunkCount,
  tsvEscape,
  userChunk,
  userChunks,
  userCountries,
  type DatasetSpec,
} from '../src/server/seed/generator';
import { ENUMS } from '../src/shared/schema';
import { PRESETS } from '../src/shared/presets';

const small: DatasetSpec = { seed: 42, users: 1_000, orders: 5_000 };
// Two order chunks and two user chunks, to cross chunk boundaries.
const twoChunks: DatasetSpec = { seed: 7, users: CHUNK_ROWS + 500, orders: CHUNK_ROWS + 2_000 };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => l.split('\t'));
const ordersText = (spec: DatasetSpec) => {
  const gen = new OrderGenerator(spec, userCountries(spec));
  return [...gen.chunks()].map((c) => c.text).join('');
};

describe('mulberry32 and hashKey', () => {
  it('gives the same stream for the same seed, in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 10_000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('gives unrelated streams for neighbouring chunk numbers', () => {
    expect(hashKey(42, 'orders', 0)).not.toBe(hashKey(42, 'orders', 1));
    expect(mulberry32(hashKey(42, 'orders', 0))()).not.toBe(mulberry32(hashKey(42, 'orders', 1))());
  });
});

describe('tsvEscape', () => {
  it('escapes the characters COPY text and TabSeparated treat specially', () => {
    expect(tsvEscape('plain')).toBe('plain');
    expect(tsvEscape('a\tb')).toBe('a\\tb');
    expect(tsvEscape('a\nb\rc')).toBe('a\\nb\\rc');
    expect(tsvEscape('back\\slash')).toBe('back\\\\slash');
    expect(tsvEscape('Åsa Øster-Müller')).toBe('Åsa Øster-Müller');
  });
});

describe('determinism', () => {
  // If this changes on purpose, bump GENERATOR_VERSION so existing datasets show as "incomplete".
  it('matches the pinned output for a small dataset', () => {
    expect(sha256(userChunk(small, 0).text)).toBe('bca4e7b652f684e7082e0a8bfb766b0a787f9e4790bcef1290f0bf59a8fcbf69');
    expect(sha256(new OrderGenerator(small, userCountries(small)).chunk(0).text)).toBe('24a12931e613954ab45dda62d43c9aaedee5a1b13c465aa57a62c2b98f87e653');
  });

  it('gives the same rows for the same seed and different rows for another seed', () => {
    expect(ordersText(small)).toBe(ordersText({ ...small }));
    expect(userChunk(small, 0).text).toBe(userChunk({ ...small }, 0).text);
    expect(ordersText({ ...small, seed: 43 })).not.toBe(ordersText(small));
    expect(userChunk({ ...small, seed: 43 }, 0).text).not.toBe(userChunk(small, 0).text);
  });

  it('gives the same chunk whatever order the chunks are read in', () => {
    const countries = userCountries(twoChunks);
    const forward = new OrderGenerator(twoChunks, countries);
    const backward = new OrderGenerator(twoChunks, countries);
    const second = backward.chunk(1).text;
    expect(forward.chunk(0).text).toBe(backward.chunk(0).text);
    expect(forward.chunk(1).text).toBe(second);
  });

  it('gives the same countries whether or not the text is built', () => {
    const countries = new Uint8Array(small.users);
    userChunk(small, 0, countries, true);
    expect(countries).toEqual(userCountries(small));
  });
});

describe('users', () => {
  const rows = [...userChunks(twoChunks)].flatMap((c) => lines(c.text));
  const plans: readonly string[] = ENUMS.user_plan;

  it('has 9 fields per row and sequential ids across chunks', () => {
    expect(rows).toHaveLength(twoChunks.users);
    expect(rows.find((r, i) => r.length !== 9 || r[0] !== String(i + 1))).toBeUndefined();
  });

  it('produces values that fit the schema', () => {
    const bad = rows.find(([, first, last, email, country, city, signup, birth, plan]) =>
      !(first && last && country && city) ||
      !/^[a-z]+\.[a-z]+\d*@[a-z0-9.-]+\.[a-z]+$/.test(email) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(signup) || signup < '2019-01-01' || signup > '2025-12-31' ||
      +birth < 1955 || +birth >= 2007 ||
      !plans.includes(plan));
    expect(bad).toBeUndefined();
  });
});

describe('orders', () => {
  const countries = userCountries(twoChunks);
  const gen = new OrderGenerator(twoChunks, countries);
  const chunks = [...gen.chunks()];
  const rows = chunks.flatMap((c) => lines(c.text));
  const categories: readonly string[] = ENUMS.order_category;
  const statuses: readonly string[] = ENUMS.order_status;
  const payments: readonly string[] = ENUMS.payment_method;

  it('has 8 fields per row and sequential ids across chunks', () => {
    expect(chunks).toHaveLength(orderChunkCount(twoChunks));
    expect(chunks.map((c) => c.rows)).toEqual([CHUNK_ROWS, 2_000]);
    expect(rows).toHaveLength(twoChunks.orders);
    expect(rows.find((r, i) => r.length !== 8 || r[0] !== String(i + 1))).toBeUndefined();
  });

  it('is in time order, including across chunk boundaries, within 2024–2025', () => {
    const bad = rows.find((r, i) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r[2]) || (i > 0 && r[2] < rows[i - 1][2]));
    expect(bad).toBeUndefined();
    expect(rows[0][2] >= '2024-01-01 00:00:00').toBe(true);
    expect(rows[rows.length - 1][2] < '2026-01-01 00:00:00').toBe(true);
  });

  it('produces values that fit the schema', () => {
    const bad = rows.find(([, userId, , category, qty, price, status, pay]) =>
      +userId < 1 || +userId > twoChunks.users ||
      !categories.includes(category) ||
      +qty < 1 || +qty > 10 ||
      !/^\d+$/.test(price) || +price <= 0 ||
      !statuses.includes(status) ||
      !payments.includes(pay));
    expect(bad).toBeUndefined();
  });
});

describe('user permutation', () => {
  // Order user ids are (rank * 48271) % users + 1. That is only a bijection if 48271 shares no
  // factor with the user count, which holds for every preset (48271 is prime).
  it.each(PRESETS.map((p) => p.users))('maps every rank to a different user for %i users', (users) => {
    const seen = new Uint8Array(users);
    for (let rank = 0; rank < users; rank++) seen[(rank * 48_271) % users] = 1;
    expect(seen.every((x) => x === 1)).toBe(true);
  });
});
