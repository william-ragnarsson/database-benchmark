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
}

export const TEMPLATE_GROUPS = [
  'Aggregations',
  'Time series',
  'Distinct & percentiles',
  'Joins',
  'Text search',
  'Where Postgres wins',
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
    id: 'users-by-signup-year',
    group: 'Aggregations',
    title: 'Users by signup year & plan',
    why: 'A small table (users) with a cheap aggregate. Both engines finish in a few milliseconds, so it is close to a tie.',
    expectedWinner: 'tie',
    sql: `SELECT extract(year FROM signup_date) AS yr, plan, count(*) AS users, avg(2026 - birth_year) AS avg_age
FROM users
GROUP BY yr, plan
ORDER BY yr, plan`,
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
    id: 'distinct-buyers-per-month',
    group: 'Distinct & percentiles',
    title: 'Distinct buyers per month in 2025',
    why: 'COUNT(DISTINCT) is exact on both. Postgres sorts in a single process for it; ClickHouse uses parallel hash sets.',
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
    id: 'top-customers',
    group: 'Joins',
    title: 'Top 10 customers by spend',
    why: 'Aggregate first, then join only 10 rows. The aggregate is the heavy part.',
    expectedWinner: 'ch',
    sql: `WITH t AS (
  SELECT user_id, sum(quantity * price_cents) AS spent_cents, count(*) AS orders
  FROM orders
  WHERE status = 'completed'
  GROUP BY user_id
  ORDER BY spent_cents DESC, user_id
  LIMIT 10
)
SELECT u.id, u.first_name, u.last_name, u.country, t.spent_cents, t.orders
FROM t
JOIN users u ON u.id = t.user_id
ORDER BY t.spent_cents DESC, u.id`,
  },
  {
    id: 'card-share-by-country',
    group: 'Joins',
    title: 'Card share by country',
    why: 'CASE + HAVING over a JOIN. Same shape as revenue by country, with more work per row.',
    expectedWinner: 'ch',
    sql: `SELECT u.country, count(*) AS orders,
       100.0 * sum(CASE WHEN o.payment_method = 'card' THEN 1 ELSE 0 END) / count(*) AS card_pct
FROM orders o
JOIN users u ON u.id = o.user_id
GROUP BY u.country
HAVING count(*) >= 1000
ORDER BY card_pct DESC, u.country`,
  },
  {
    id: 'email-city-search',
    group: 'Text search',
    title: 'Email + city search',
    why: 'ILIKE over the users table. Neither engine has an index for it and the table is small, so both take a few ms. ClickHouse’s ~3–5 ms fixed cost per query usually puts Postgres slightly ahead.',
    expectedWinner: 'tie',
    sql: `SELECT id, first_name, last_name, email, city
FROM users
WHERE email ILIKE '%son%' AND city ILIKE 'san%'
ORDER BY id
LIMIT 50`,
  },
  {
    id: 'order-by-id',
    group: 'Where Postgres wins',
    title: 'Order #242424',
    why: 'A point lookup. Postgres walks its B-tree and reads one page; ClickHouse has to scan the id column, because its data is sorted by created_at, not id. Postgres also has a lower fixed cost per query.',
    expectedWinner: 'pg',
    sql: `SELECT id, user_id, created_at, category, quantity, price_cents, status, payment_method
FROM orders
WHERE id = 242424`,
  },
  {
    id: 'customer-last-orders',
    group: 'Where Postgres wins',
    title: 'Customer 4242’s last 20 orders',
    why: 'Postgres uses its B-tree on user_id and touches a handful of rows; ClickHouse scans the user_id column, because user_id is not its sort key.',
    expectedWinner: 'pg',
    sql: `SELECT id, created_at, category, quantity, price_cents, status
FROM orders
WHERE user_id = 4242
ORDER BY created_at DESC, id DESC
LIMIT 20`,
  },
];

export function templateSql(t: Template): { pg: string; ch: string } {
  return typeof t.sql === 'string' ? { pg: t.sql, ch: t.sql } : t.sql;
}
