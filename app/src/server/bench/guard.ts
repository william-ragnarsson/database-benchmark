// Checks that a query is one read-only SELECT before it is sent anywhere, and wraps it so
// both engines stop after the same number of rows. The lexer knows each dialect's strings,
// quoted names and comments, so a ';' or a keyword inside them is never mistaken for SQL.
// It is a convenience, not the security boundary: the read-only users are.

import type { Engine } from '../../shared/types';

export const SHOWN_ROWS = 100;
export const FETCH_ROWS = SHOWN_ROWS + 1;

export class GuardError extends Error {}

type Kind = 'word' | 'string' | 'ident' | 'comment' | 'space' | 'punct' | 'number';

interface Token {
  kind: Kind;
  text: string;
}

function lex(sql: string, engine: Engine): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  const push = (kind: Kind, end: number) => {
    tokens.push({ kind, text: sql.slice(i, end) });
    i = end;
  };
  // A quoted run that ends at `quote`. Doubling the quote escapes it in both dialects;
  // ClickHouse also accepts a backslash escape, and so does Postgres in E'…' strings.
  const quoted = (start: number, quote: string, backslash: boolean): number => {
    let j = start;
    while (j < n) {
      const c = sql[j];
      if (backslash && c === '\\') j += 2;
      else if (c === quote) {
        if (sql[j + 1] === quote) j += 2;
        else return j + 1;
      } else j++;
    }
    throw new GuardError('The query has an unclosed quote.');
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push('space', j);
    } else if ((c === '-' && next === '-') || (engine === 'ch' && c === '#')) {
      const j = sql.indexOf('\n', i);
      push('comment', j === -1 ? n : j);
    } else if (c === '/' && next === '*') {
      // Both engines allow nested block comments.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) throw new GuardError('The query has an unclosed /* comment.');
      push('comment', j);
    } else if (c === "'") {
      push('string', quoted(i + 1, "'", engine === 'ch'));
    } else if (engine === 'pg' && (c === 'E' || c === 'e') && next === "'") {
      push('string', quoted(i + 2, "'", true));
    } else if (c === '"') {
      push('ident', quoted(i + 1, '"', engine === 'ch'));
    } else if (engine === 'ch' && c === '`') {
      push('ident', quoted(i + 1, '`', true));
    } else if (engine === 'pg' && c === '$' && /[A-Za-z_$]/.test(next ?? '')) {
      // Dollar-quoted string: $tag$ … $tag$ (or $$ … $$).
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        if (end === -1) throw new GuardError('The query has an unclosed $$ string.');
        push('string', end + m[0].length);
      } else push('punct', i + 1);
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      push('word', j);
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
      push('number', j);
    } else {
      push('punct', i + 1);
    }
  }
  return tokens;
}

const isTrivia = (t: Token) => t.kind === 'space' || t.kind === 'comment';

// Statements that change data. Postgres allows them inside WITH; nothing else here needs them.
const WRITE_WORDS = new Set(['insert', 'update', 'delete', 'merge']);
const AGGREGATING_WORDS = new Set([
  'group', 'distinct', 'order', 'count', 'sum', 'avg', 'min', 'max', 'uniq', 'uniqexact',
  'percentile_cont', 'percentile_disc', 'string_agg', 'array_agg', 'grouparray', 'countif', 'sumif', 'any',
]);

export interface Prepared {
  // The query with trailing comments, whitespace and semicolons removed.
  sql: string;
  // Lowercased words outside strings and comments.
  words: Set<string>;
}

export function prepare(sql: string, engine: Engine): Prepared {
  const tokens = lex(sql, engine);
  // Strip trailing trivia and ';' until none are left, so "SELECT 1; -- done" is one statement.
  let end = tokens.length;
  while (end > 0 && (isTrivia(tokens[end - 1]) || tokens[end - 1].text === ';')) end--;
  const body = tokens.slice(0, end);
  const significant = body.filter((t) => !isTrivia(t));
  if (!significant.length) throw new GuardError('The query is empty.');

  const first = significant[0];
  const firstWord = first.kind === 'word' ? first.text.toLowerCase() : first.text;
  if (firstWord !== 'select' && firstWord !== 'with' && firstWord !== '(') {
    throw new GuardError('Only SELECT queries can run here (a query must start with SELECT or WITH).');
  }
  if (significant.some((t) => t.text === ';')) throw new GuardError('Only one statement at a time: remove the extra ";".');

  const words = new Set(significant.filter((t) => t.kind === 'word').map((t) => t.text.toLowerCase()));
  for (const w of WRITE_WORDS) {
    if (words.has(w)) throw new GuardError(`Only read queries can run here, but this one contains ${w.toUpperCase()}.`);
  }
  return { sql: body.map((t) => t.text).join(''), words };
}

// The query goes on its own lines, so a trailing "-- comment" inside it can't swallow the wrapper.
export const WRAP_PREFIX = 'SELECT * FROM (\n';

export function wrap(sql: string): string {
  return `${WRAP_PREFIX}${sql}\n) q LIMIT ${FETCH_ROWS}`;
}

export function hasLimit(p: Prepared): boolean {
  return p.words.has('limit') || p.words.has('offset') || p.words.has('fetch');
}

// A rough keyword check for the "only the first 101 rows were fetched" hint.
export function looksAggregating(p: Prepared): boolean {
  for (const w of p.words) {
    if (AGGREGATING_WORDS.has(w) || w.startsWith('quantile')) return true;
  }
  return false;
}
