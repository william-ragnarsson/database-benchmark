import { useEffect, useState, type ReactNode } from 'react';
import postgresLogo from '../logos/postgres.svg';
import clickhouseLogo from '../logos/clickhouse.svg';
import type { Engine } from '../../shared/types';

// Page 4: a short history of databases, written as one post. Each exhibit fixed a problem with
// the one before; each section ends with what was still wrong, which the next exhibit fixed.

type Family = 'tree' | 'network' | 'relational' | 'document' | 'column';

// The ways of storing data, one lane each on the map. Colors are --fam in styles.css.
const FAMILIES: { id: Family; label: string }[] = [
  { id: 'tree', label: 'Tree' },
  { id: 'network', label: 'Network' },
  { id: 'relational', label: 'Tables' },
  { id: 'document', label: 'Documents' },
  { id: 'column', label: 'Columns' },
];

interface Exhibit {
  id: string;
  year: number;
  name: string;
  maker: string;
  family: Family;
  // One of the two databases this site races.
  engine?: Engine;
  text: string;
  picture: ReactNode;
  caption: string;
  // What was still wrong, which the next exhibit fixed.
  problem?: string;
}

const EXHIBITS: Exhibit[] = [
  {
    id: 'ims',
    year: 1968,
    name: 'IMS',
    maker: 'IBM, for NASA’s Apollo program',
    family: 'tree',
    text: 'IBM built it to keep track of the millions of parts that went into Apollo. It stores records as a tree, where every record has one parent. It was the first database to be widely used, and banks still run it.',
    picture: <Parts shared={false} />,
    caption: 'One parent each, so the same bolt is stored twice.',
    problem: 'Copies drift apart when only one is changed.',
  },
  {
    id: 'network',
    year: 1969,
    name: 'The network model',
    maker: 'CODASYL, the group behind COBOL',
    family: 'network',
    text: 'A record can have many parents, so the bolt is stored once, linked from both engines. The idea came from IDS, which Charles Bachman built at General Electric in 1964.',
    picture: <Parts shared />,
    caption: 'Both engines link to the same bolt.',
    problem: 'Programs had to follow the links one record at a time. If the links changed, every program had to change too.',
  },
  {
    id: 'relational',
    year: 1970,
    name: 'The relational model',
    maker: 'Edgar F. Codd, IBM',
    family: 'relational',
    text: 'Codd proposed keeping data in plain tables, and matching rows in different tables on a shared value instead of linking them. A query says what data it wants, and the database works out how to find it.',
    picture: <Tables />,
    caption: 'Rows in the two tables match on the engine name.',
    problem: 'Codd’s model existed only on paper. Nobody knew if it could be made fast, and IBM wanted to keep selling IMS.',
  },
  {
    id: 'sql',
    year: 1974,
    name: 'System R and Ingres',
    maker: 'IBM San Jose and UC Berkeley',
    family: 'relational',
    text: 'IBM built System R and Berkeley built Ingres to test Codd’s model in practice. SQL was created for System R. In 1979 Oracle sold the first SQL database.',
    picture: <Query />,
    caption: 'A SQL query for the F-1 engine’s parts, and the result.',
    problem: 'Tables could only hold a few built-in kinds of value, such as numbers, text and dates. You couldn’t add your own.',
  },
  {
    id: 'postgres',
    year: 1986,
    name: 'Postgres',
    maker: 'Michael Stonebraker, UC Berkeley',
    family: 'relational',
    engine: 'pg',
    text: 'Stonebraker’s team started it after Ingres, and the name means “post-Ingres”. It lets you add your own kinds of data. It switched to SQL in 1995 and was renamed PostgreSQL in 1996.',
    picture: <Lineage />,
    caption: 'Ingres led to Postgres, which became PostgreSQL.',
    problem: 'In the 1990s, many small websites needed a database that was fast and simple to set up.',
  },
  {
    id: 'mysql',
    year: 1995,
    name: 'MySQL',
    maker: 'MySQL AB, Sweden',
    family: 'relational',
    text: 'It was free, fast and easy to set up. It became the M in LAMP, and in the 2000s it ran much of the web, including Wikipedia and Facebook.',
    picture: <Lamp />,
    caption: 'Four free tools that made a website.',
    problem: 'Big websites had more data than one server could handle, and SQL databases were hard to split across many servers.',
  },
  {
    id: 'mongodb',
    year: 2009,
    name: 'MongoDB',
    maker: '10gen, now MongoDB Inc.',
    family: 'document',
    text: 'Each record is a document with no fixed columns, so it can change shape as the app does. It was designed to spread across many servers.',
    picture: <Doc />,
    caption: 'One record, with a list inside it.',
    problem: 'All of these keep each record’s fields together, so to average one field they have to read every record in full.',
  },
  {
    id: 'clickhouse',
    year: 2016,
    name: 'ClickHouse',
    maker: 'Yandex',
    family: 'column',
    engine: 'ch',
    text: 'Yandex built it to count clicks for its web analytics, and made it open source in 2016. It stores each column separately, so a query reads only the columns it needs.',
    picture: <Columns />,
    caption: 'To average the weight, a row store reads every cell. A column store reads one column.',
  },
];

const ENGINE_LOGO: Record<Engine, string> = { pg: postgresLogo, ch: clickhouseLogo };

export function HistoryPage() {
  return (
    <>
      <h1 className="headline history-title" id="history-title" tabIndex={-1}>
        A short history of databases
      </h1>
      <p className="history-sub">Eight databases and data models, oldest first. Each one fixed a problem with the one before it.</p>

      <Overview />

      {EXHIBITS.map((e) => (
        <article key={e.id} className={`exhibit fam-${e.family}`} id={`exhibit-${e.id}`} aria-labelledby={`exhibit-${e.id}-name`}>
          <h2 id={`exhibit-${e.id}-name`} tabIndex={-1}>
            {e.year}: {e.name}
          </h2>
          <p className="exhibit-maker">
            {e.maker}
            {/* The space before the dot is where a narrow screen breaks the line. */}
            {e.engine && (
              <>
                {' '}
                <span className="exhibit-here">
                  ·{' '}
                  <img src={ENGINE_LOGO[e.engine]} alt="" width={16} height={16} />
                  On this site
                </span>
              </>
            )}
          </p>
          <p>{e.text}</p>
          <figure className="exhibit-picture">
            {e.picture}
            <figcaption>{e.caption}</figcaption>
          </figure>
          {e.problem && (
            <p>
              <span className="visually-hidden">Problem: </span>
              {e.problem}
            </p>
          )}
        </article>
      ))}

      <p className="closing">
        This site compares Postgres, which keeps each row together, with ClickHouse, which keeps each column together.{' '}
        <a href="#/run">Run a query</a> to see the difference.
      </p>
    </>
  );
}

// ---------- the map ----------

const FROM = 1965;
const NOW = new Date().getFullYear();
const DECADES = Array.from({ length: Math.floor((NOW - 1970) / 10) + 1 }, (_, i) => 1970 + i * 10);
const at = (year: number): string => `${(100 * (year - FROM)) / (NOW - FROM)}%`;

// Scroll to an exhibit and put focus on its name, so the keyboard carries on from there.
function show(id: string) {
  const section = document.getElementById(`exhibit-${id}`);
  if (!section) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}

// One lane per way of storing data, from its first exhibit to today, with a dot for each exhibit.
function Overview() {
  // A dot's tip covers the lane above it, so Escape hides it until the pointer or focus moves on.
  const [hush, setHush] = useState(false);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setHush(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <figure className={hush ? 'map map-hush' : 'map'} onFocus={() => setHush(false)} onPointerOver={() => setHush(false)}>
      {FAMILIES.map((f) => {
        const dots = EXHIBITS.filter((e) => e.family === f.id);
        return (
          <div key={f.id} className={`map-lane fam-${f.id}`}>
            <span className="map-name">{f.label}</span>
            <div className="map-track">
              {DECADES.map((y) => (
                <i key={y} className="map-tick" style={{ left: at(y) }} aria-hidden />
              ))}
              <span className="map-line" style={{ left: at(dots[0].year) }} aria-hidden />
              {dots.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`map-dot${e.year < 1980 ? ' map-dot-start' : e.year > 2005 ? ' map-dot-end' : ''}`}
                  style={{ left: at(e.year) }}
                  data-tip={`${e.year}: ${e.name}`}
                  aria-label={`${e.year}: ${e.name} (${f.label})`}
                  onClick={() => show(e.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="map-lane map-axis" aria-hidden>
        <span />
        <div className="map-track">
          {DECADES.map((y) => (
            <span key={y} style={{ left: at(y) }}>
              {y}
            </span>
          ))}
        </div>
      </div>
      <figcaption>Each line is a way of storing data. Click a dot to jump to it.</figcaption>
    </figure>
  );
}

// ---------- the pictures ----------

// A labelled box, centred on cx. on: drawn in the exhibit's color.
function Box({ cx, y, w, label, on, copy }: { cx: number; y: number; w: number; label: string; on?: boolean; copy?: boolean }) {
  return (
    <g className={`dg-box${on ? ' on' : ''}${copy ? ' copy' : ''}`}>
      <rect x={cx - w / 2} y={y} width={w} height={28} rx={6} />
      <text x={cx} y={y + 18.5} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

// A rocket's parts. As a tree the shared bolt is copied; as a network it's stored once.
function Parts({ shared }: { shared: boolean }) {
  return (
    <svg
      className="dg"
      viewBox="0 0 320 156"
      role="img"
      aria-label={
        shared ? 'Saturn V has two engines, F-1 and J-2, both linked to one bolt' : 'Saturn V has two engines, F-1 and J-2, each linked to its own bolt'
      }
    >
      <path className="dg-link" d="M160 36 76 64M160 36l84 28" />
      {shared ? <path className="dg-link on" d="M76 92l60 28M244 92l-60 28" /> : <path className="dg-link on" d="M76 92v28M244 92v28" />}
      <Box cx={160} y={8} w={96} label="Saturn V" />
      <Box cx={76} y={64} w={104} label="F-1 engine" />
      <Box cx={244} y={64} w={104} label="J-2 engine" />
      {shared ? (
        <Box cx={160} y={120} w={64} label="Bolt" on />
      ) : (
        <>
          <Box cx={76} y={120} w={64} label="Bolt" on />
          <Box cx={244} y={120} w={96} label="Bolt (copy)" on copy />
        </>
      )}
    </svg>
  );
}

const CELL_H = 26;

function Table({ x, title, cols, rows, match }: { x: number; title: string; cols: [string, number][]; rows: string[][]; match: number }) {
  let left = x;
  const lefts = cols.map(([, w]) => (left += w) - w);
  return (
    <g>
      <text className="dg-title" x={x} y={13}>
        {title}
      </text>
      {cols.map(([head, w], c) => (
        <g key={head}>
          <rect className="dg-head" x={lefts[c]} y={22} width={w} height={CELL_H} />
          <text className="dg-th" x={lefts[c] + 8} y={39}>
            {head}
          </text>
          {rows.map((row, r) => (
            <g key={r} className={`dg-cell${c === match ? ' on' : ''}`}>
              <rect x={lefts[c]} y={22 + CELL_H * (r + 1)} width={w} height={CELL_H} />
              <text x={lefts[c] + 8} y={39 + CELL_H * (r + 1)}>
                {row[c]}
              </text>
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

// Two tables joined on the engine's name.
function Tables() {
  return (
    <svg className="dg" viewBox="0 0 320 104" role="img" aria-label="Table engines: stage 1, F-1; stage 2, J-2. Table parts: F-1, Bolt; J-2, Valve.">
      <Table x={8} title="engines" cols={[['stage', 56], ['engine', 72]]} rows={[['1', 'F-1'], ['2', 'J-2']]} match={1} />
      <Table x={184} title="parts" cols={[['engine', 72], ['part', 56]]} rows={[['F-1', 'Bolt'], ['J-2', 'Valve']]} match={0} />
      <path className="dg-link on" d="M136 61H184M136 87H184" />
    </svg>
  );
}

function Query() {
  return (
    <div className="dg-query">
      <pre className="dg-code">
        <code>{`SELECT part\nFROM parts\nWHERE engine = 'F-1';`}</code>
      </pre>
      <span className="dg-arrow" aria-hidden>
        →
      </span>
      <span className="dg-answer">
        <span className="visually-hidden">Answer: </span>Bolt
      </span>
    </div>
  );
}

// From Ingres to the Postgres this site races. Hidden from screen readers: the caption says it all.
function Lineage() {
  return (
    <svg className="dg" viewBox="0 0 320 40" aria-hidden>
      <path className="dg-link" d="M76 20H108" />
      <path className="dg-link on" d="M192 20H224" />
      <Box cx={38} y={6} w={76} label="Ingres" />
      <Box cx={150} y={6} w={84} label="Postgres" on />
      <Box cx={272} y={6} w={96} label="PostgreSQL" on />
    </svg>
  );
}

function Lamp() {
  const parts: [string, string, string][] = [
    ['L', 'inux', 'system'],
    ['A', 'pache', 'web server'],
    ['M', 'ySQL', 'database'],
    ['P', 'HP', 'code'],
  ];
  return (
    <ul className="dg-lamp">
      {parts.map(([first, rest, job]) => (
        <li key={first} className={first === 'M' ? 'on' : undefined}>
          <span>
            <b>{first}</b>
            {rest}
          </span>
          <small>{job}</small>
        </li>
      ))}
    </ul>
  );
}

function Doc() {
  return (
    <pre className="dg-code">
      <code>{`{
  "engine": "F-1",
  "stage": 1,
  "parts": [
    { "name": "Bolt" },
    { "name": "Valve" }
  ]
}`}</code>
    </pre>
  );
}

// The same 4 × 4 cells, kept by row and by column. Lit: what averaging the weight reads.
function Columns() {
  const W = 28;
  const H = 14;
  const cells = (x: number, gapX: number, gapY: number, lit: (c: number) => boolean) =>
    [0, 1, 2, 3].flatMap((r) =>
      [0, 1, 2, 3].map((c) => (
        <rect key={`${r}${c}`} className={`dg-bit${lit(c) ? ' on' : ''}`} x={x + c * (W + gapX)} y={40 + r * (H + gapY)} width={W} height={H} rx={2} />
      )),
    );
  return (
    <svg className="dg" viewBox="0 0 320 136" role="img" aria-label="A row store reads all 16 cells, a column store reads the 4 weight cells">
      <text x={0} y={13}>
        Row store
      </text>
      <text x={176} y={13}>
        Column store
      </text>
      <text className="dg-th" x={0 + 3 * (W + 2) + W / 2} y={32} textAnchor="middle">
        weight
      </text>
      <text className="dg-th" x={176 + 3 * (W + 8) + W / 2} y={32} textAnchor="middle">
        weight
      </text>
      {cells(0, 2, 6, () => true)}
      {cells(176, 8, 2, (c) => c === 3)}
      <text className="dg-count" x={0} y={130}>
        reads 16 cells
      </text>
      <text className="dg-count" x={176} y={130}>
        reads 4 cells
      </text>
    </svg>
  );
}
