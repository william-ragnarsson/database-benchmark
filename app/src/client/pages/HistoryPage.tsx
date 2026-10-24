import { useEffect, useState } from 'react';
import { ENGINE_LABEL, fmtCount, fmtMs, fmtRatio } from '../format';
import { Dialog } from '../components/Dialog';
import { PRESETS } from '../../shared/presets';
import type { HistoryEntry } from '../history';
import type { Engine, EngineStatus } from '../../shared/types';

const STATUS_TEXT: Record<Exclude<EngineStatus, 'ok'>, string> = {
  timeout: 'timed out',
  error: 'error',
  cancelled: 'cancelled',
};

interface Props {
  entries: HistoryEntry[];
  onClear: () => void;
  active: boolean;
}

// Page 3: every finished run, newest first. Kept in this browser only, the last 50.
export function HistoryPage({ entries, onClear, active }: Props) {
  const [confirming, setConfirming] = useState(false);
  const close = () => setConfirming(false);

  // Back or Forward while the confirm is open: close it, or it stays modal on a hidden page.
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);

  return (
    <>
      <h1 className="visually-hidden" tabIndex={-1}>
        History of runs
      </h1>

      {entries.length === 0 ? (
        <div className="empty">
          <p>No runs yet.</p>
          <p className="muted small">
            Runs show up here as soon as they finish. <a href="#/run">Run a query</a>
          </p>
        </div>
      ) : (
        <>
          {/* Focusable so the keyboard can scroll it sideways when the columns don't fit. */}
          <div className="sheet history" role="region" aria-label="Run history" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Query</th>
                  <th scope="col">Data</th>
                  <th scope="col" className="num pg-ink">
                    Postgres
                  </th>
                  <th scope="col" className="num ch-ink">
                    ClickHouse
                  </th>
                  <th scope="col" className="num">
                    Faster
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const preset = PRESETS.find((p) => p.id === e.preset);
                  return (
                    <tr key={e.id}>
                      <td className="when">
                        <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
                          {whenText(e.at)}
                        </time>
                      </td>
                      <td className={e.title ? undefined : 'mono'}>{e.title ?? firstLine(e.sql.pg)}</td>
                      <td className="when">{preset ? `${fmtCount(preset.orders)} orders` : '—'}</td>
                      <td className="ms">{timeText(e, 'pg')}</td>
                      <td className="ms">{timeText(e, 'ch')}</td>
                      <td className="faster">
                        <Faster entry={e} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="history-foot">
            <button type="button" className="btn btn-danger btn-small" onClick={() => setConfirming(true)}>
              Clear history…
            </button>
          </div>
        </>
      )}

      <Dialog
        open={confirming}
        onClose={close}
        title={`Clear all ${entries.length} ${entries.length === 1 ? 'run' : 'runs'}?`}
        footer={
          <>
            <button type="button" className="btn" data-autofocus onClick={close}>
              Keep
            </button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => {
                onClear();
                close();
              }}
            >
              Clear
            </button>
          </>
        }
      >
        <p>The list is only stored in this browser. The databases and their data are not touched.</p>
      </Dialog>
    </>
  );
}

// "Today 21:46", "Yesterday 18:12", or the date for anything older.
function whenText(at: string): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === new Date().toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

function timeText(e: HistoryEntry, engine: Engine): string {
  const s = e.statuses[engine];
  if (s === 'timeout') return '> 30 s';
  if (s !== 'ok') return STATUS_TEXT[s];
  return fmtMs(e.ms[engine]);
}

function Faster({ entry }: { entry: HistoryEntry }) {
  const bad = (['pg', 'ch'] as Engine[]).find((x) => entry.statuses[x] === 'error' || entry.statuses[x] === 'cancelled');
  if (bad) return <span className="muted">{STATUS_TEXT[entry.statuses[bad] as Exclude<EngineStatus, 'ok'>]}</span>;
  if (entry.ratio === null) return <span className="muted">{entry.statuses.pg === 'timeout' ? 'Both timed out' : '—'}</span>;
  if (!entry.winner) return <span className="muted">About the same</span>;
  return (
    <span className={`${entry.winner}-ink`}>
      {ENGINE_LABEL[entry.winner]} {entry.lowerBound ? '≥ ' : ''}
      {fmtRatio(entry.ratio)}
    </span>
  );
}

function firstLine(sql: string): string {
  const line = sql.trim().split('\n')[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
