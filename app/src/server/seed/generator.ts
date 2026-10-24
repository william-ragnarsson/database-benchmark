// Seeded data generator. Each 50k-row chunk gets its own random stream from hash(seed, table, chunk),
// so any engine can read the chunks independently and still receive byte-identical TSV.
// Bump GENERATOR_VERSION whenever the output changes: older datasets then show as "incomplete".

import { ENUMS } from '../../shared/schema';
import { CATEGORY_PRICES, COUNTRIES, EMAIL_DOMAINS, FIRST_NAMES, LAST_NAMES } from './words';

export const GENERATOR_VERSION = 1;
export const DEFAULT_SEED = 42;
export const CHUNK_ROWS = 50_000;

export interface DatasetSpec {
  seed: number;
  users: number;
  orders: number;
}

export interface Chunk {
  text: string;
  rows: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, then a murmur3 finaliser so neighbouring chunk numbers give unrelated streams.
export function hashKey(...parts: (string | number)[]): number {
  const s = parts.join(':');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Postgres COPY text format and ClickHouse TabSeparated share these escapes.
export function tsvEscape(s: string): string {
  return /[\\\t\n\r]/.test(s)
    ? s.replace(/[\\\t\n\r]/g, (c) => (c === '\\' ? '\\\\' : c === '\t' ? '\\t' : c === '\n' ? '\\n' : '\\r'))
    : s;
}

function picker<T>(items: [T, number][]): (u: number) => T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  const cum = items.map(([, w]) => w / total);
  for (let i = 1; i < cum.length; i++) cum[i] += cum[i - 1];
  return (u) => {
    for (let i = 0; i < cum.length - 1; i++) if (u < cum[i]) return items[i][0];
    return items[items.length - 1][0];
  };
}

const pad2 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const DAY = 86_400;

function isoDay(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

// ---- users ----

const firstNames = FIRST_NAMES.map(tsvEscape);
const lastNames = LAST_NAMES.map(tsvEscape);
const emailLocal = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const firstLocal = FIRST_NAMES.map(emailLocal);
const lastLocal = LAST_NAMES.map(emailLocal);
const pickDomain = picker(EMAIL_DOMAINS);
const pickCountry = picker(COUNTRIES.map((c, i) => [i, c.weight] as [number, number]));
const countryNames = COUNTRIES.map((c) => tsvEscape(c.name));
const countryCities = COUNTRIES.map((c) => c.cities.map(tsvEscape));
const pickPlan = picker<string>([['free', 70], ['pro', 22], ['team', 8]]);

const SIGNUP_START = Date.UTC(2019, 0, 1) / 1000;
const SIGNUP_DAYS = (Date.UTC(2026, 0, 1) / 1000 - SIGNUP_START) / DAY;
const signupDays = Array.from({ length: SIGNUP_DAYS }, (_, d) => isoDay(SIGNUP_START + d * DAY));

export function userChunkCount(spec: DatasetSpec): number {
  return Math.ceil(spec.users / CHUNK_ROWS);
}

// One chunk of users. `countries` (if given) receives each user's country index.
export function userChunk(spec: DatasetSpec, chunk: number, countries?: Uint8Array, wantText = true): Chunk {
  const rng = mulberry32(hashKey(spec.seed, 'users', chunk));
  const start = chunk * CHUNK_ROWS;
  const end = Math.min(spec.users, start + CHUNK_ROWS);
  let text = '';
  for (let i = start; i < end; i++) {
    const f = Math.floor(rng() * firstNames.length);
    const l = Math.floor(rng() * lastNames.length);
    const withNumber = rng() >= 0.3;
    const num = 1 + Math.floor(rng() * 9999);
    const domain = pickDomain(rng());
    const country = pickCountry(rng());
    const cities = countryCities[country];
    // Earlier cities in each list are the bigger ones.
    const city = cities[Math.floor(cities.length * Math.pow(rng(), 1.6))];
    // sqrt skews signups towards recent years.
    const signup = signupDays[Math.floor(SIGNUP_DAYS * Math.sqrt(rng()))];
    const birth = 1955 + Math.floor((52 * (rng() + rng() + rng())) / 3);
    const plan = pickPlan(rng());
    if (countries) countries[i] = country;
    if (!wantText) continue;
    const email = `${firstLocal[f]}.${lastLocal[l]}${withNumber ? num : ''}@${domain}`;
    text += `${i + 1}\t${firstNames[f]}\t${lastNames[l]}\t${email}\t${countryNames[country]}\t${city}\t${signup}\t${birth}\t${plan}\n`;
  }
  return { text, rows: end - start };
}

export function* userChunks(spec: DatasetSpec): Generator<Chunk> {
  for (let c = 0; c < userChunkCount(spec); c++) yield userChunk(spec, c);
}

// Order payment methods depend on the buyer's country, so orders need every user's country.
export function userCountries(spec: DatasetSpec): Uint8Array {
  const countries = new Uint8Array(spec.users);
  for (let c = 0; c < userChunkCount(spec); c++) userChunk(spec, c, countries, false);
  return countries;
}

// ---- orders ----

const ORDER_START = Date.UTC(2024, 0, 1) / 1000;
const ORDER_DAYS = (Date.UTC(2026, 0, 1) / 1000 - ORDER_START) / DAY; // 731
const ORDER_END = ORDER_START + ORDER_DAYS * DAY;
const orderDays = Array.from({ length: ORDER_DAYS }, (_, d) => isoDay(ORDER_START + d * DAY) + ' ');

// Sunday first, as getUTCDay() counts.
const WEEKDAY = [1.12, 1.05, 1.0, 0.98, 0.97, 0.92, 0.95];
const MONTH = [0.85, 0.82, 0.95, 0.95, 1.0, 0.98, 0.95, 0.97, 0.98, 1.02, 1.25, 1.45];
// Orders per hour of day (UTC): quiet nights, an evening peak.
const HOURS = [
  0.35, 0.22, 0.15, 0.12, 0.12, 0.18, 0.35, 0.6, 0.85, 1.0, 1.05, 1.1,
  1.15, 1.1, 1.05, 1.05, 1.1, 1.2, 1.35, 1.5, 1.55, 1.4, 1.0, 0.6,
];
const hourTotal = HOURS.reduce((a, b) => a + b, 0);
const hourCum = [0];
for (const w of HOURS) hourCum.push(hourCum[hourCum.length - 1] + w / hourTotal);

// Seconds into the day for f in [0, 1). Monotonic in f, so rows stay in time order.
function secondOfDay(f: number): number {
  let h = 0;
  while (h < 23 && f >= hourCum[h + 1]) h++;
  const within = (f - hourCum[h]) / (hourCum[h + 1] - hourCum[h]);
  return h * 3600 + Math.min(3599, Math.floor(within * 3600));
}

function blackFriday(year: number): number {
  const nov1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const thanksgiving = 1 + ((4 - nov1 + 7) % 7) + 21;
  return Date.UTC(year, 10, thanksgiving + 1) / 1000;
}

function dayWeights(seed: number): Float64Array {
  const rng = mulberry32(hashKey(seed, 'days', 0));
  const special = new Map<number, number>();
  for (const year of [2024, 2025]) {
    const bf = blackFriday(year);
    special.set(bf, 2.5);
    special.set(bf + 3 * DAY, 2.0); // Cyber Monday
    special.set(Date.UTC(year, 11, 25) / 1000, 0.6);
  }
  const w = new Float64Array(ORDER_DAYS);
  for (let d = 0; d < ORDER_DAYS; d++) {
    const t = ORDER_START + d * DAY;
    const date = new Date(t * 1000);
    const growth = 1 + (0.6 * d) / (ORDER_DAYS - 1);
    w[d] = WEEKDAY[date.getUTCDay()] * MONTH[date.getUTCMonth()] * growth * (special.get(t) ?? 1) * (0.9 + 0.2 * rng());
  }
  return w;
}

// dayStart[d] = index of the first order on day d; dayStart[ORDER_DAYS] = number of orders.
function dayStarts(spec: DatasetSpec): Float64Array {
  const w = dayWeights(spec.seed);
  const total = w.reduce((a, b) => a + b, 0);
  const starts = new Float64Array(ORDER_DAYS + 1);
  let cum = 0;
  for (let d = 0; d < ORDER_DAYS; d++) {
    starts[d] = Math.round((spec.orders * cum) / total);
    cum += w[d];
  }
  starts[ORDER_DAYS] = spec.orders;
  return starts;
}

const CATEGORIES = Object.entries(CATEGORY_PRICES);
const pickCategory = picker(CATEGORIES.map(([, [weight]], i) => [i, weight] as [number, number]));
const pickQuantity = picker<number>([
  [1, 70], [2, 15], [3, 6], [4, 3], [5, 2], [6, 1.2], [7, 0.8], [8, 0.7], [9, 0.6], [10, 0.7],
]);
// Recent orders are still on their way; older ones are mostly completed.
type Status = (typeof ENUMS.order_status)[number];
const pickStatusNew = picker<Status>([['pending', 55], ['shipped', 35], ['completed', 5], ['cancelled', 5]]);
const pickStatusRecent = picker<Status>([['pending', 8], ['shipped', 42], ['completed', 44], ['cancelled', 5], ['refunded', 1]]);
const pickStatusOld = picker<Status>([['completed', 89], ['cancelled', 5.5], ['refunded', 4], ['shipped', 1], ['pending', 0.5]]);
const pickNonCard = picker<string>([['paypal', 42], ['apple_pay', 26], ['bank_transfer', 20], ['gift_card', 12]]);
// A fixed permutation, so the heaviest buyers are spread over the id range instead of being users 1, 2, 3…
const USER_PERMUTE = 48_271;

export function orderChunkCount(spec: DatasetSpec): number {
  return Math.ceil(spec.orders / CHUNK_ROWS);
}

export class OrderGenerator {
  private starts: Float64Array;

  constructor(private spec: DatasetSpec, private countries: Uint8Array) {
    this.starts = dayStarts(spec);
  }

  chunk(chunk: number): Chunk {
    const { spec, starts, countries } = this;
    const rng = mulberry32(hashKey(spec.seed, 'orders', chunk));
    const start = chunk * CHUNK_ROWS;
    const end = Math.min(spec.orders, start + CHUNK_ROWS);
    // Last day whose first order is at or before `start`.
    let lo = 0;
    let hi = ORDER_DAYS - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= start) lo = mid;
      else hi = mid - 1;
    }
    let d = lo;
    let text = '';
    for (let i = start; i < end; i++) {
      while (i >= starts[d + 1]) d++;
      const j = i - starts[d];
      const count = starts[d + 1] - starts[d];
      const sec = secondOfDay((j + rng()) / count);
      const created = ORDER_START + d * DAY + sec;

      const heavy = rng() < 0.8;
      const u = rng();
      const rank = heavy ? Math.floor(spec.users * Math.pow(u, 1.5)) : Math.floor(spec.users * u);
      const userIdx = (rank * USER_PERMUTE) % spec.users;

      const cat = pickCategory(rng());
      const [, min, max] = CATEGORIES[cat][1];
      const raw = Math.exp(Math.log(min) + rng() * (Math.log(max) - Math.log(min)));
      const price = Math.max(min, Math.round(raw / 100) * 100 - 1);
      const qty = pickQuantity(rng());

      const ageDays = (ORDER_END - created) / DAY;
      const us = rng();
      const status = ageDays < 3 ? pickStatusNew(us) : ageDays < 14 ? pickStatusRecent(us) : pickStatusOld(us);
      const up = rng();
      const card = COUNTRIES[countries[userIdx]].cardShare;
      const pay = up < card ? 'card' : pickNonCard((up - card) / (1 - card));

      const hh = pad2[(sec / 3600) | 0];
      const mm = pad2[((sec % 3600) / 60) | 0];
      const ss = pad2[sec % 60];
      text += `${i + 1}\t${userIdx + 1}\t${orderDays[d]}${hh}:${mm}:${ss}\t${CATEGORIES[cat][0]}\t${qty}\t${price}\t${status}\t${pay}\n`;
    }
    return { text, rows: end - start };
  }

  *chunks(): Generator<Chunk> {
    for (let c = 0; c < orderChunkCount(this.spec); c++) yield this.chunk(c);
  }
}
