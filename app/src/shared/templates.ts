// Template queries. Each one runs on both engines and returns the same rows on both.
// Portability rules used throughout: fixed date literals (never now()), CAST(… AS DATE)
// instead of a bare date_trunc, no integer division, no round(), a full tie-break before LIMIT.

export interface Template {
  id: string;
  group: string;
  title: string;
  why: string;
  expectedWinner: 'pg' | 'ch' | 'tie';
  // Same SQL on both engines, or one per engine.
  sql: string | { pg: string; ch: string };
  // Why each engine gets its own SQL, shown under it on the Run page.
  sqlNote?: string;
}

export const TEMPLATE_GROUPS = [
  'Aggregations',
  'Index lookups',
  'Time series',
  'Joins',
  'Distinct & percentiles',
  'Text search',
] as const;

export const TEMPLATES: Template[] = [
  {
    id: 'revenue-by-category',
    group: 'Aggregations',
    title: 'Revenue by category',
    why: 'A full scan with GROUP BY. ClickHouse reads only the 4 columns it needs, compressed, with all cores.',
    expectedWinner: 'ch',
    sql: `SELECT category, count(*) AS orders, sum(quantity * price_cents) AS revenue_cents
FROM orders
WHERE status = 'completed'
GROUP BY category
ORDER BY category`,
  },
  {
    id: 'busiest-customer-days',
    group: 'Aggregations',
    title: 'Busiest customer-days',
    why: 'GROUP BY with about a million groups. ClickHouse’s vectorised hash tables handle huge group counts far faster.',
    expectedWinner: 'ch',
    sql: `SELECT user_id, CAST(created_at AS DATE) AS day, count(*) AS orders
FROM orders
GROUP BY user_id, day
ORDER BY orders DESC, user_id, day
LIMIT 20`,
  },
  {
    id: 'order-by-id',
    group: 'Index lookups',
    title: 'Order #242424',
    why: 'A point lookup. Postgres walks its B-tree and reads one page; ClickHouse has to scan the id column, because its data is sorted by created_at, not id. Postgres also has a lower fixed cost per query.',
    expectedWinner: 'pg',
    sql: `SELECT id, user_id, created_at, category, quantity, price_cents, status, payment_method
FROM orders
WHERE id = 242424`,
  },
  {
    id: 'user-by-id',
    group: 'Index lookups',
    title: 'User #99',
    why: 'A point lookup ClickHouse’s index can serve too: users are sorted by id, so it reads one block of 8,192 rows. Postgres reads one page, and its fixed cost per query is far lower, so it still wins.',
    expectedWinner: 'pg',
    sql: `SELECT id, first_name, last_name, email, country, city, signup_date, birth_year, plan
FROM users
WHERE id = 99`,
  },
  {
    id: 'customer-last-orders',
    group: 'Index lookups',
    title: 'Customer 4242’s last 20 orders',
    why: 'Postgres uses its B-tree on user_id and touches a handful of rows; ClickHouse scans the user_id column, because user_id is not its sort key.',
    expectedWinner: 'pg',
    sql: `SELECT id, created_at, category, quantity, price_cents, status
FROM orders
WHERE user_id = 4242
ORDER BY created_at DESC, id DESC
LIMIT 20`,
  },
  {
    id: 'newest-orders',
    group: 'Index lookups',
    title: 'Last 20 orders by id',
    why: 'ORDER BY id with a LIMIT. Postgres walks its id index from the end and stops after 20 rows; ClickHouse is sorted by created_at, not id, so it reads every id to find the top 20. Sort by created_at instead and the same 20 rows come back, but ClickHouse wins: that is its sort key, and Postgres has only a BRIN index there, so it reads every row.',
    expectedWinner: 'pg',
    sql: `SELECT id, user_id, created_at, category, quantity, price_cents, status
FROM orders
ORDER BY id DESC
LIMIT 20`,
  },
  {
    id: 'daily-orders',
    group: 'Time series',
    title: 'Daily orders & revenue, Mar–May 2025',
    why: 'A time range plus GROUP BY day. Postgres uses its BRIN index, ClickHouse its sparse primary index on created_at.',
    expectedWinner: 'ch',
    sql: `SELECT CAST(created_at AS DATE) AS day, count(*) AS orders, sum(quantity * price_cents) AS revenue_cents
FROM orders
WHERE created_at >= '2025-03-01' AND created_at < '2025-06-01'
GROUP BY day
ORDER BY day`,
  },
  {
    id: 'running-monthly-revenue',
    group: 'Time series',
    title: 'Running monthly revenue',
    why: 'A window function over a full-scan aggregate. The aggregate dominates, and ClickHouse scans faster. Postgres gets a MATERIALIZED CTE: it guesses one month per distinct timestamp, and would otherwise sort every order (past its 100 MB temp-file limit at Large).',
    expectedWinner: 'ch',
    sqlNote: 'The same steps, written two ways. Postgres gets a MATERIALIZED CTE, so it sums each month before the window runs instead of sorting every order. ClickHouse gets a plain subquery.',
    sql: {
      pg: `WITH t AS MATERIALIZED (
  SELECT CAST(date_trunc('month', created_at) AS DATE) AS month, sum(quantity * price_cents) AS revenue_cents
  FROM orders
  GROUP BY 1
)
SELECT month, revenue_cents, sum(revenue_cents) OVER (ORDER BY month) AS running_cents
FROM t
ORDER BY month`,
      ch: `SELECT month, revenue_cents, sum(revenue_cents) OVER (ORDER BY month) AS running_cents
FROM (
  SELECT CAST(date_trunc('month', created_at) AS DATE) AS month, sum(quantity * price_cents) AS revenue_cents
  FROM orders
  GROUP BY 1
) t
ORDER BY month`,
    },
  },
  {
    id: 'last-five-minutes',
    group: 'Time series',
    title: 'Orders in the last 5 minutes of 2025',
    why: 'A very short time range. Both skip straight to it: Postgres with its BRIN index, ClickHouse with its primary index on created_at. With only a few rows left to read, ClickHouse’s fixed cost per query decides it.',
    expectedWinner: 'pg',
    sql: `SELECT id, user_id, created_at, price_cents
FROM orders
WHERE created_at >= '2025-12-31 23:55:00' AND created_at < '2026-01-01'
ORDER BY created_at, id`,
  },
  {
    id: 'revenue-by-country',
    group: 'Joins',
    title: 'Revenue by country',
    why: 'A JOIN of every order to its user, then GROUP BY. ClickHouse builds the hash table once and probes it in parallel.',
    expectedWinner: 'ch',
    sql: `SELECT u.country, count(*) AS orders, sum(o.quantity * o.price_cents) AS revenue_cents
FROM orders o
JOIN users u ON u.id = o.user_id
GROUP BY u.country
ORDER BY revenue_cents DESC, u.country
LIMIT 20`,
  },
  {
    id: 'customer-spend-by-category',
    group: 'Joins',
    title: 'Customer 4242’s spend by category',
    why: 'A JOIN for one customer. Postgres finds them by id, then their orders through its user_id index: a handful of rows. ClickHouse scans the whole user_id column of orders, because orders are sorted by created_at.',
    expectedWinner: 'pg',
    sql: `SELECT u.first_name, u.last_name, o.category, count(*) AS orders, sum(o.quantity * o.price_cents) AS spent_cents
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.id = 4242
GROUP BY u.first_name, u.last_name, o.category
ORDER BY spent_cents DESC, o.category`,
  },
  {
    id: 'distinct-buyers-per-month',
    group: 'Distinct & percentiles',
    title: 'Distinct buyers per month in 2025',
    why: 'COUNT(DISTINCT) is exact on both. Postgres sorts the rows for it; ClickHouse uses parallel hash sets.',
    expectedWinner: 'ch',
    sql: `SELECT CAST(date_trunc('month', created_at) AS DATE) AS month, count(DISTINCT user_id) AS buyers
FROM orders
WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'
GROUP BY 1
ORDER BY 1`,
  },
  {
    id: 'price-percentiles',
    group: 'Distinct & percentiles',
    title: 'Median & p90 price by category',
    why: 'Exact percentiles. Postgres percentile_cont sorts each group; ClickHouse quantileExactInclusive uses the same interpolation, in parallel.',
    expectedWinner: 'ch',
    sqlNote: 'The two engines spell exact percentiles differently. Postgres’s percentile_cont and ClickHouse’s quantileExactInclusive interpolate the same way, so both return the same values.',
    sql: {
      pg: `SELECT category,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY price_cents) AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY price_cents) AS p90
FROM orders
GROUP BY category
ORDER BY category`,
      ch: `SELECT category,
       quantileExactInclusive(0.5)(price_cents) AS p50,
       quantileExactInclusive(0.9)(price_cents) AS p90
FROM orders
GROUP BY category
ORDER BY category`,
    },
  },
  {
    id: 'email-city-search',
    group: 'Text search',
    title: 'Email + city search',
    why: 'ILIKE over the users table. Neither engine has an index for it, and a B-tree couldn’t serve a leading % anyway. Both walk users in id order and stop early: Postgres at the 50th match, about 4,000 rows in; ClickHouse after its first two blocks of 8,192 rows. With so little to read, ClickHouse’s fixed cost per query is about half its time.',
    expectedWinner: 'pg',
    sql: `SELECT id, first_name, last_name, email, city
FROM users
WHERE email ILIKE '%son%' AND city ILIKE 'san%'
ORDER BY id
LIMIT 50`,
  },
];

export function templateSql(t: Template): { pg: string; ch: string } {
  return typeof t.sql === 'string' ? { pg: t.sql, ch: t.sql } : t.sql;
}
