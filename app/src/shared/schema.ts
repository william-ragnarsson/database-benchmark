// One description of the two tables. The server builds both engines' DDL from it and the
// page shows it in the dataset panel, so the two can never drift apart.

export const ENUMS = {
  user_plan: ['free', 'pro', 'team'],
  order_category: [
    'electronics', 'books', 'clothing', 'home', 'beauty',
    'sports', 'toys', 'grocery', 'garden', 'automotive',
  ],
  order_status: ['completed', 'shipped', 'pending', 'cancelled', 'refunded'],
  payment_method: ['card', 'paypal', 'apple_pay', 'bank_transfer', 'gift_card'],
} as const;

export type EnumName = keyof typeof ENUMS;

export interface ColumnDef {
  name: string;
  pg: string;
  ch: string;
  // Extra ClickHouse column clause such as a codec.
  chCodec?: string;
  enumName?: EnumName;
  note: string;
}

export interface TableDef {
  name: 'users' | 'orders';
  description: string;
  columns: ColumnDef[];
  pgIndexes: string[];
  chOrderBy: string;
}

function chEnum(name: EnumName): string {
  return `Enum8(${ENUMS[name].map((v, i) => `'${v}' = ${i + 1}`).join(', ')})`;
}

export const TABLES: TableDef[] = [
  {
    name: 'users',
    description: 'One row per customer.',
    columns: [
      { name: 'id', pg: 'int4', ch: 'Int32', note: 'Primary key, 1…N' },
      { name: 'first_name', pg: 'text', ch: 'LowCardinality(String)', note: '~150 common first names' },
      { name: 'last_name', pg: 'text', ch: 'LowCardinality(String)', note: '~200 common last names' },
      { name: 'email', pg: 'text', ch: 'String', note: 'first.last{n}@ a weighted domain list' },
      { name: 'country', pg: 'text', ch: 'LowCardinality(String)', note: '13 weighted countries' },
      { name: 'city', pg: 'text', ch: 'LowCardinality(String)', note: 'A city in that country' },
      { name: 'signup_date', pg: 'date', ch: 'Date', note: '2019–2025, more recent signups' },
      { name: 'birth_year', pg: 'int2', ch: 'Int16', note: '1955–2006' },
      { name: 'plan', pg: 'user_plan', ch: chEnum('user_plan'), enumName: 'user_plan', note: 'free / pro / team' },
    ],
    pgIndexes: ['PRIMARY KEY (id)'],
    chOrderBy: 'id',
  },
  {
    name: 'orders',
    description: 'One row per order, in time order.',
    columns: [
      { name: 'id', pg: 'int4', ch: 'Int32', chCodec: 'CODEC(Delta, ZSTD)', note: 'Primary key, rises with created_at' },
      { name: 'user_id', pg: 'int4', ch: 'Int32', note: 'A few heavy buyers, a long tail of light ones' },
      { name: 'created_at', pg: 'timestamptz', ch: "DateTime('UTC')", chCodec: 'CODEC(Delta, ZSTD)', note: '2024–2025, weekly and seasonal patterns' },
      { name: 'category', pg: 'order_category', ch: chEnum('order_category'), enumName: 'order_category', note: '10 categories' },
      { name: 'quantity', pg: 'int2', ch: 'Int16', note: 'Mostly 1, up to 10' },
      { name: 'price_cents', pg: 'int4', ch: 'Int32', note: 'Range depends on the category' },
      { name: 'status', pg: 'order_status', ch: chEnum('order_status'), enumName: 'order_status', note: 'Mostly completed; recent orders pending or shipped' },
      { name: 'payment_method', pg: 'payment_method', ch: chEnum('payment_method'), enumName: 'payment_method', note: 'Card share differs by country' },
    ],
    pgIndexes: ['PRIMARY KEY (id)', 'B-tree (user_id)', 'BRIN (created_at)'],
    chOrderBy: '(created_at, id)',
  },
];
