import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, RequestError } from '../api';
import { dataBytes, fmtBytes, fmtCount, fmtDuration } from '../format';
import { Dialog } from '../components/Dialog';
import { DEFAULT_PRESET } from '../../shared/presets';
import { TABLES } from '../../shared/schema';
import type { LifecycleState, Meta, Preset, PresetId, RowsResponse, SeedPhase, Status } from '../../shared/types';

const PAGE_SIZE = 20;

type TableName = (typeof TABLES)[number]['name'];

interface Props {
  status: Status;
  refresh: () => void;
  // Why Generate and Delete can't start right now (a query is being timed), or null.
  blocked: string | null;
  active: boolean;
}

type JobKind = 'seed' | 'delete' | 'check';

// Starts a seed, delete or recheck. The status poll then shows its progress. A failure stays
// shown until the status moves on (resetKey changes), since by then its cause is gone.
function useJob(refresh: () => void, resetKey: string) {
  const [pending, setPending] = useState<JobKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [resetKey]);
  const start = async (kind: JobKind, fn: () => Promise<unknown>) => {
    setPending(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
      refresh();
    }
  };
  return { pending, error, start };
}

// Page 1: pick a size, generate or delete the data, and page through it.
export function DatabasePage({ status, refresh, blocked, active }: Props) {
  const { state, meta, sizes } = status;
  const [picked, setPicked] = useState<PresetId | null>(null);
  const [confirm, setConfirm] = useState<'generate' | 'delete' | null>(null);
  const job = useJob(refresh, `${state}:${status.busy?.kind ?? ''}`);
  const done = useDoneMessage(status);

  const selected = picked ?? status.error?.preset ?? meta?.preset ?? DEFAULT_PRESET;
  const preset = status.presets.find((p) => p.id === selected);
  const bytes = dataBytes(sizes);
  const overhead = (sizes?.pg?.overheadBytes ?? 0) + (sizes?.ch?.overheadBytes ?? 0);
  const seeding = state === 'seeding' || job.pending === 'seed';
  const deleting = state === 'deleting' || job.pending === 'delete';
  const working = seeding || deleting || state === 'starting' || job.pending === 'check';
  const hasData = state === 'ready' || ((state === 'incomplete' || state === 'error') && bytes > 0);
  const close = () => setConfirm(null);
  const generateOff = working || !!blocked || !preset;
  const deleteOff = working || !!blocked || !hasData;

  // Back or Forward while a confirm is open: close it, or it stays modal on a hidden page.
  useEffect(() => {
    if (!active) setConfirm(null);
  }, [active]);

  const seed = () => {
    close();
    void job.start('seed', () => api.seed(selected));
  };
  const remove = () => {
    close();
    void job.start('delete', api.deleteAll);
  };

  return (
    <>
      <h1 className="visually-hidden" tabIndex={-1}>
        Database
      </h1>

      <div className="bar">
        <span className="bar-label" id="size-label">
          Size
        </span>
        <SizePicker presets={status.presets} selected={selected} onSelect={setPicked} />
        {/* aria-disabled, not disabled: pressing Generate turns it off, and a disabled button
            would drop focus to <body>. The click handler is removed instead. */}
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={generateOff || undefined}
          // Generating replaces what's there, and Large is well above the default size: both ask first.
          onClick={generateOff ? undefined : () => (hasData || preset?.warning ? setConfirm('generate') : seed())}
        >
          {seeding ? 'Generating…' : 'Generate'}
        </button>
        <button
          type="button"
          className="btn btn-danger bar-end"
          aria-disabled={deleteOff || undefined}
          onClick={deleteOff ? undefined : () => setConfirm('delete')}
        >
          {deleting ? 'Deleting…' : 'Delete data…'}
        </button>
      </div>
      {blocked && !working && <p className="reason">{blocked}</p>}
      {job.error && (
        <div className="banner bad" role="alert">
          {job.error}
        </div>
      )}
      <p className="visually-hidden" role="status">
        {done}
      </p>

      <Body status={status} active={active} disabled={!!job.pending} onRetry={job.start} />

      {preset && (
        <Dialog
          open={confirm === 'generate'}
          onClose={close}
          title={hasData ? 'Replace the current data?' : `Generate ~${preset.estDiskMB} MB?`}
          footer={
            <>
              <button type="button" className="btn" data-autofocus onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={seed}>
                Generate
              </button>
            </>
          }
        >
          <p>
            {hasData ? `This deletes the ${fmtBytes(bytes)} there now and generates` : 'This generates'}{' '}
            {fmtCount(preset.orders)} orders (~{preset.estDiskMB} MB). It takes about {fmtDuration(preset.estSeedSec)}.
          </p>
          {preset.warning && <p className="warn-text">{preset.warning}</p>}
        </Dialog>
      )}

      <Dialog
        open={confirm === 'delete'}
        onClose={close}
        title="Delete all data?"
        footer={
          <>
            <button type="button" className="btn" data-autofocus onClick={close}>
              Keep it
            </button>
            <button type="button" className="btn btn-danger-solid" onClick={remove}>
              Delete {fmtBytes(bytes)}
            </button>
          </>
        }
      >
        <p>This drops the tables in both databases and frees about {fmtBytes(bytes)}. You can generate data again any time.</p>
        <p className="muted">
          The empty databases keep {overhead > 0 ? `about ${fmtBytes(overhead)}` : 'a little space'} until you run{' '}
          <code>./uninstall.sh</code>.
        </p>
      </Dialog>
    </>
  );
}

// What to announce when a generate or delete finishes: the progress note it replaces goes quietly.
function useDoneMessage(status: Status): string {
  const prev = useRef<LifecycleState>(status.state);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (prev.current === 'seeding' && status.state === 'ready') setMessage('The data is generated.');
    else if (prev.current === 'deleting' && status.state === 'empty') {
      setMessage(status.lastFreedBytes !== null ? `Deleted. Freed ${fmtBytes(status.lastFreedBytes)}.` : 'Deleted.');
    } else if (prev.current !== status.state) setMessage('');
    prev.current = status.state;
  }, [status.state, status.lastFreedBytes]);
  return message;
}

// The sizes as one radio group: arrow keys move between them, Tab leaves the group.
function SizePicker({ presets, selected, onSelect }: { presets: Preset[]; selected: PresetId; onSelect: (id: PresetId) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (i + step + presets.length) % presets.length;
    onSelect(presets[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="sizes" role="radiogroup" aria-labelledby="size-label">
      {presets.map((p, i) => {
        const on = p.id === selected;
        return (
          <button
            key={p.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <b>
              {on && <Check />}~{p.estDiskMB} MB
            </b>
            <span>{fmtCount(p.orders)} orders</span>
          </button>
        );
      })}
    </div>
  );
}

function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 7.5l3 3 6-7" />
    </svg>
  );
}

function errorTitle(job: 'seed' | 'delete' | 'boot'): string {
  if (job === 'seed') return 'Generating the data failed.';
  if (job === 'delete') return 'Deleting the data failed.';
  return 'The databases could not be prepared.';
}

interface BodyProps {
  status: Status;
  active: boolean;
  disabled: boolean;
  onRetry: (kind: JobKind, fn: () => Promise<unknown>) => void;
}

// Whatever sits under the bar: the table, the empty state, progress, or what went wrong.
function Body({ status, active, disabled, onRetry }: BodyProps) {
  const { state, meta, error } = status;

  if (state === 'starting') {
    return (
      <div className="note" role="status">
        <span className="spinner" aria-hidden />
        <p>
          <b>Starting the databases…</b> <span className="muted">The first start can take a minute.</span>
        </p>
      </div>
    );
  }

  if (state === 'seeding' || state === 'deleting') return <Progress status={status} />;

  if (state === 'ready' && meta) return <TableBrowser key={meta.seededAt} meta={meta} active={active} />;

  if (state === 'error' && error) {
    const retry = () => {
      if (error.job === 'seed') onRetry('seed', () => api.seed(error.preset ?? DEFAULT_PRESET));
      else if (error.job === 'delete') onRetry('delete', api.deleteAll);
      else onRetry('check', api.recheck);
    };
    return (
      <div className="banner bad" role="alert">
        <p>
          <b>{errorTitle(error.job)}</b> {error.message}
        </p>
        <button type="button" className="btn btn-small" disabled={disabled} onClick={retry}>
          {error.job === 'boot' ? 'Check again' : 'Retry'}
        </button>
      </div>
    );
  }

  if (state === 'incomplete') {
    return (
      <div className="banner warn">
        <p>
          <b>The data needs to be generated again.</b> {status.incompleteReason} Press Generate, or delete what is
          left.
        </p>
      </div>
    );
  }

  return (
    <div className="empty">
      <p>No data yet. Pick a size and press Generate.</p>
      {status.lastFreedBytes !== null && (
        <p className="muted small">The last delete freed {fmtBytes(status.lastFreedBytes)}.</p>
      )}
    </div>
  );
}

const PHASE_TEXT: Record<SeedPhase, string> = {
  deleting: 'Deleting the old data',
  loading: 'Loading rows',
  indexing: 'Building indexes',
  verifying: 'Checking both engines match',
  warming: 'Warming up',
  done: 'Finishing',
};

function Progress({ status }: { status: Status }) {
  // Re-render every second for the elapsed time.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const p = status.progress;
  if (!p || p.kind === 'delete') {
    return (
      <div className="note" role="status">
        <span className="spinner" aria-hidden />
        <p>
          <b>{status.state === 'deleting' ? 'Deleting all data…' : 'Starting…'}</b>
        </p>
      </div>
    );
  }

  const preset = status.presets.find((x) => x.id === p.preset);
  const done = p.engines.pg.rowsDone + p.engines.ch.rowsDone;
  const total = p.engines.pg.rowsTotal + p.engines.ch.rowsTotal;
  const loading = p.phase === 'loading' && total > 0;
  const pct = loading ? Math.min(100, Math.floor((100 * done) / total)) : p.phase === 'deleting' ? 0 : 100;
  const elapsedSec = Math.max(0, (Date.now() - Date.parse(p.startedAt)) / 1000);

  return (
    <div className="note progress">
      {/* Only the phase is announced; the ticking time and percentage stay quiet. */}
      <p className="visually-hidden" role="status">
        {PHASE_TEXT[p.phase]}
      </p>
      <p>
        <b>Generating ~{preset?.estDiskMB ?? '?'} MB</b> · {PHASE_TEXT[p.phase]}
        {loading && ` ${pct}%`}…
      </p>
      <div className={`meter${loading ? '' : ' indeterminate'}`} aria-hidden>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="muted small">
        {fmtDuration(elapsedSec)} elapsed
        {p.etaSec !== null && ` · about ${fmtDuration(p.etaSec)} left`} · it keeps going if you close this tab
      </p>
    </div>
  );
}

// Postgres sends timestamptz as "… +00"; shown without the offset, like ClickHouse sends it.
const cell = (v: unknown) => (v === null ? 'NULL' : String(v).replace(/\+00$/, ''));

// One table, 20 rows a page. Ids are 1…N, so page n is a plain id range.
function TableBrowser({ meta, active }: { meta: Meta; active: boolean }) {
  const [table, setTable] = useState<TableName>('orders');
  const [pages, setPages] = useState<Record<TableName, number>>({ orders: 1, users: 1 });
  const [loaded, setLoaded] = useState<{ key: string; res: RowsResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const tabs = useRef<Partial<Record<TableName, HTMLButtonElement | null>>>({});

  const totals: Record<TableName, number> = { orders: meta.orders, users: meta.users };
  const pageCount = Math.max(1, Math.ceil(totals[table] / PAGE_SIZE));
  const page = Math.min(pages[table], pageCount);
  const key = `${table}:${page}`;
  const loadedKey = loaded?.key ?? null;

  useEffect(() => {
    if (!active || loadedKey === key) return;
    setError(null);
    const ctrl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    api.rows(table, page, PAGE_SIZE, ctrl.signal).then(
      (res) => setLoaded({ key, res }),
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        // Someone holds the lock for a moment: try again shortly. When it's this table's own
        // previous read (the server finishes it even after we gave up on it), that's very soon.
        if (err instanceof RequestError && err.status === 409) {
          retry = setTimeout(() => setNonce((n) => n + 1), err.busy?.kind === 'browse' ? 150 : 1500);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      ctrl.abort();
      clearTimeout(retry);
    };
  }, [active, key, loadedKey, nonce, table, page]);

  const goTo = (p: number) => setPages((s) => ({ ...s, [table]: Math.min(Math.max(1, p), pageCount) }));

  const names = TABLES.map((t) => t.name);
  const onTabKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = names[(names.indexOf(table) + step + names.length) % names.length];
    setTable(next);
    tabs.current[next]?.focus();
  };

  const def = TABLES.find((t) => t.name === table)!;
  const numeric = new Set(def.columns.filter((c) => /^int/.test(c.pg)).map((c) => c.name));
  // While the next page loads, the current one stays up, dimmed. Another table's rows don't.
  const shown = loaded && loaded.res.table === table ? loaded.res.pg : null;
  const stale = loadedKey !== key;

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Table">
        {names.map((name) => (
          <button
            key={name}
            ref={(el) => {
              tabs.current[name] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${name}`}
            aria-controls="table-panel"
            aria-selected={name === table}
            tabIndex={name === table ? 0 : -1}
            onClick={() => setTable(name)}
            onKeyDown={onTabKey}
          >
            {name} <span>{totals[name].toLocaleString('en-US')}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="banner bad" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-small" onClick={() => setNonce((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      <div
        className={`sheet rows${stale ? ' stale' : ''}`}
        role="tabpanel"
        id="table-panel"
        aria-labelledby={`tab-${table}`}
        aria-busy={stale}
        tabIndex={0}
      >
        {shown ? (
          <table>
            <thead>
              <tr>
                {shown.columns.map((c) => (
                  <th key={c} scope="col" className={numeric.has(c) ? 'num' : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((row) => (
                <tr key={String(row[0])}>
                  {row.map((v, j) => (
                    <td key={j} className={numeric.has(shown.columns[j]) ? 'num' : undefined}>
                      {cell(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          !error && (
            <p className="rows-loading">
              <span className="spinner" aria-hidden /> Reading rows…
            </p>
          )
        )}
      </div>

      {/* aria-disabled for the same reason as Generate: Prev on page 2 turns itself off. */}
      <div className="pager" role="group" aria-label={`${table} pages`}>
        <button type="button" className="btn" aria-disabled={page <= 1 || undefined} onClick={page <= 1 ? undefined : () => goTo(page - 1)}>
          <span aria-hidden>‹ </span>Prev
        </button>
        <span className="pager-info" aria-live="polite">
          Page {page.toLocaleString('en-US')} of {pageCount.toLocaleString('en-US')}
        </span>
        <button
          type="button"
          className="btn"
          aria-disabled={page >= pageCount || undefined}
          onClick={page >= pageCount ? undefined : () => goTo(page + 1)}
        >
          Next<span aria-hidden> ›</span>
        </button>
      </div>
    </>
  );
}
