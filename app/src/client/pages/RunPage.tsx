import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { Reads } from '../components/Reads';
import { ENGINE_LABEL, fmtMs, fmtRatio } from '../format';
import type { HistoryInfo } from '../history';
import type { Data } from '../scenes';
import { TEMPLATES, templateSql } from '../../shared/templates';
import type { Engine, EngineResult, RunResult, Status } from '../../shared/types';

const RUNS = 5;
const ENGINES: Engine[] = ['pg', 'ch'];

interface Props {
  status: Status;
  // Why Run can't start right now, or null.
  blocked: string | null;
  running: boolean;
  setRunning: (running: boolean) => void;
  onFinished: (result: RunResult, info: HistoryInfo) => void;
}

// Measured runs finished so far, and how many each engine will get (fewer after a slow warm-up).
interface Live {
  done: Record<Engine, number>;
  target: Record<Engine, number | null>;
}

// A result, with the data it was measured on, so its drawing stays the same if the data changes.
interface Last {
  result: RunResult;
  data: Data | null;
  baselineMs: Status['baselineMs'];
}

// Page 2: pick a query, run it on both engines, compare the times.
export function RunPage({ status, blocked, running, setRunning, onFinished }: Props) {
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [last, setLast] = useState<Last | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const off = running || !!blocked;
  // The last result only belongs under the query it was run for.
  const shown = last && last.result.templateId === templateId ? last : null;

  const run = async () => {
    const t = template;
    setRunning(true);
    setError(null);
    // A run that fails shows only its error, not the last run's result under it.
    setLast(null);
    setLive({ done: { pg: 0, ch: 0 }, target: { pg: null, ch: null } });
    let failure: string | null = null;
    try {
      await api.run({ ...templateSql(t), runs: RUNS, templateId: t.id }, (e) => {
        if (e.type === 'warmup') setLive((l) => l && { ...l, target: { ...l.target, [e.engine]: e.runs } });
        else if (e.type === 'run') setLive((l) => l && { ...l, done: { ...l.done, [e.engine]: e.index + 1 } });
        else if (e.type === 'error') failure = e.message;
        else if (e.type === 'done') {
          setLast({ result: e.result, data: status.meta, baselineMs: status.baselineMs });
          onFinished(e.result, {
            sql: templateSql(t),
            separate: typeof t.sql !== 'string',
            title: t.title,
            preset: status.meta?.preset ?? null,
          });
        }
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      setError(failure);
      setLive(null);
      setRunning(false);
    }
  };

  return (
    <>
      <h1 className="visually-hidden" tabIndex={-1}>
        Run a query
      </h1>

      <div className="bar">
        <div className="select">
          <label className="visually-hidden" htmlFor="query">
            Query
          </label>
          <select id="query" value={templateId} disabled={running} onChange={(e) => setTemplateId(e.target.value)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 6l4 4 4-4" />
          </svg>
        </div>
        {/* aria-disabled, not disabled: pressing Run turns it off, and a disabled button would
            drop focus to <body>. The click handler is removed instead. */}
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={off || undefined}
          onClick={off ? undefined : () => void run()}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {blocked && !running && <BlockedReason status={status} text={blocked} />}
      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}

      <section className="card result" aria-labelledby="result-title" aria-live="polite" aria-busy={running}>
        {live ? (
          <LiveView title={template.title} live={live} />
        ) : shown ? (
          <ResultView result={shown.result} />
        ) : (
          <>
            <h2 className="visually-hidden" id="result-title">
              Result
            </h2>
            <p className="muted">Pick a query and press Run. Each engine warms up, then runs it up to {RUNS} times, and the times are compared here.</p>
          </>
        )}
      </section>

      {shown && shown.result.engines.pg.status === 'ok' && shown.result.engines.ch.status === 'ok' && (
        <Reads key={shown.result.runId} {...shown} paused={!!blocked} />
      )}
    </>
  );
}

function BlockedReason({ status, text }: { status: Status; text: string }) {
  if (status.state === 'empty' || status.state === 'incomplete') {
    return (
      <p className="reason">
        {status.state === 'empty' ? 'No data yet.' : 'The data needs to be generated again.'} Generate it on the{' '}
        <a href="#/data">Database page</a>.
      </p>
    );
  }
  return <p className="reason">{text}</p>;
}

function LiveView({ title, live }: { title: string; live: Live }) {
  return (
    <>
      <h2 className="headline" id="result-title">
        Running {title}…
      </h2>
      <div className="lanes">
        {ENGINES.map((e) => {
          const target = live.target[e];
          return (
            <Lane key={e} engine={e} width={target ? (100 * live.done[e]) / target : 0}>
              <span className="muted">
                {target === null ? 'warm-up' : target === 0 ? 'failed' : `${live.done[e]} of ${target}`}
              </span>
            </Lane>
          );
        })}
      </div>
    </>
  );
}

function Lane({ engine, width, bold, children }: { engine: Engine; width: number; bold?: boolean; children: ReactNode }) {
  return (
    <>
      <span className={`lane-name ${engine}-ink`}>{ENGINE_LABEL[engine]}</span>
      <div className="track" aria-hidden>
        <span className={`fill ${engine}-bar`} style={{ width: `${Math.min(100, width)}%` }} />
      </div>
      <span className={`lane-val${bold ? ' win' : ''}`}>{children}</span>
    </>
  );
}

const FAILED_TEXT = { timeout: 'timed out', error: 'error', cancelled: 'cancelled' } as const;

function ResultView({ result }: { result: RunResult }) {
  const { headline, engines, match } = result;
  const medians = ENGINES.map((e) => engines[e].medianMs).filter((ms): ms is number => ms !== null);
  const longest = Math.max(...medians, 0);
  const counts = ENGINES.map((e) => engines[e].runsMs.length);
  const sameCount = counts[0] === counts[1];
  const slow = ENGINES.filter((e) => engines[e].slow);

  return (
    <>
      <h2 className="headline" id="result-title">
        {headline.winner && headline.ratio !== null ? (
          <>
            {ENGINE_LABEL[headline.winner]}{' '}
            <span className={`${headline.winner}-ink`}>
              {headline.lowerBound && 'at least '}
              {fmtRatio(headline.ratio)}
            </span>{' '}
            faster
          </>
        ) : (
          // The server's sentence, without the "both feel instant" tail shown below instead.
          headline.text.replace(/ · .*$/, '')
        )}
      </h2>
      {headline.instant && <p className="muted small instant">Both finished in under 10 ms, so either would feel instant.</p>}

      <p className="cap">{sameCount && counts[0] > 0 ? `Median of ${counts[0]} run${counts[0] === 1 ? '' : 's'}` : 'Median time'}</p>
      <div className="lanes">
        {ENGINES.map((e) => {
          const r = engines[e];
          const ms = r.status === 'ok' ? r.medianMs : null;
          return (
            <Lane key={e} engine={e} width={ms !== null && longest > 0 ? Math.max(0.5, (100 * ms) / longest) : 0} bold={ms !== null && headline.winner === e}>
              {ms !== null ? fmtMs(ms) : r.status === 'timeout' ? '> 30 s' : FAILED_TEXT[r.status as keyof typeof FAILED_TEXT]}
            </Lane>
          );
        })}
      </div>

      {slow.length > 0 && (
        <p className="muted small">
          {slow.map((e) => ENGINE_LABEL[e]).join(' and ')} ran it once after the warm-up, since the warm-up took over a
          second.
        </p>
      )}

      {counts.some((n) => n > 1) && <RunsTable engines={engines} heading={sameCount ? `${counts[0]} runs each` : 'Runs'} />}

      <MatchLine result={result} />
      {ENGINES.map((e) => (
        <EngineProblem key={e} engine={e} r={engines[e]} />
      ))}
      {match.kind === 'mismatch' && match.hint && <p className="muted small">{match.hint}</p>}
    </>
  );
}

function RunsTable({ engines, heading }: { engines: Record<Engine, EngineResult>; heading: string }) {
  const rows: { label: string; pick: (xs: number[]) => number | null }[] = [
    { label: 'Fastest run', pick: (xs) => (xs.length ? Math.min(...xs) : null) },
    { label: 'Slowest run', pick: (xs) => (xs.length ? Math.max(...xs) : null) },
  ];
  return (
    <table className="runs">
      <thead>
        <tr>
          <th scope="col">{heading}</th>
          <th scope="col" className="pg-ink">
            Postgres
          </th>
          <th scope="col" className="ch-ink">
            ClickHouse
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, pick }) => {
          const pg = pick(engines.pg.runsMs);
          const ch = pick(engines.ch.runsMs);
          return (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className={pg !== null && (ch === null || pg < ch) ? 'win' : undefined}>{fmtMs(pg)}</td>
              <td className={ch !== null && (pg === null || ch < pg) ? 'win' : undefined}>{fmtMs(ch)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MatchLine({ result }: { result: RunResult }) {
  const { match, engines } = result;
  if (match.kind === 'match') {
    const n = engines.pg.rows.length;
    const cut = engines.pg.truncated || engines.ch.truncated;
    return (
      <p className="match ok">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2.5 7.5l3 3 6-7" />
        </svg>
        Both returned the same {cut ? `first ${n.toLocaleString('en-US')}` : n.toLocaleString('en-US')} row{n === 1 ? '' : 's'}
      </p>
    );
  }
  if (match.kind === 'mismatch') return <p className="match bad">The results differ: {match.detail}</p>;
  if (match.kind === 'not-comparable') return <p className="match muted">{match.detail}</p>;
  return null;
}

function EngineProblem({ engine, r }: { engine: Engine; r: EngineResult }) {
  if (r.status === 'ok' || r.status === 'cancelled') return null;
  return (
    <div className="banner bad">
      <p>
        <b>{ENGINE_LABEL[engine]}</b> {r.status === 'timeout' ? 'stopped after 30 s.' : r.error}
      </p>
      {r.hint && <p className="small">{r.hint}</p>}
    </div>
  );
}
