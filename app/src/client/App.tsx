import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoute, useStatus, type Route } from './hooks';
import { addHistory, clearHistory, HISTORY_KEY, loadHistory, type HistoryEntry, type HistoryInfo } from './history';
import { Nav } from './components/Nav';
import { Versus } from './components/Versus';
import { DatabasePage } from './pages/DatabasePage';
import { RunPage } from './pages/RunPage';
import { HistoryPage } from './pages/HistoryPage';
import type { JobKind, RunResult, Status } from '../shared/types';

// The server holds one lock for all tabs. A browse read holds it for a few milliseconds, so
// it isn't worth disabling buttons over.
const BUSY_TEXT: Record<Exclude<JobKind, 'browse'>, string> = {
  seed: 'Data is being generated.',
  delete: 'Data is being deleted.',
  run: 'A query is running in another tab.',
  suite: 'Queries are running in another tab.',
  explain: 'A query plan is being read in another tab.',
};

function otherTabBusy(status: Status): string | null {
  return status.busy && status.busy.kind !== 'browse' ? BUSY_TEXT[status.busy.kind] : null;
}

// Why Run can't start right now, or null if it can.
function runBlocked(status: Status): string | null {
  switch (status.state) {
    case 'starting':
      return 'The databases are starting.';
    case 'seeding':
      return 'Data is being generated.';
    case 'deleting':
      return 'Data is being deleted.';
    case 'empty':
      return 'No data yet.';
    case 'incomplete':
      return 'The data needs to be generated again.';
    case 'error':
      return 'The data isn’t ready. See the Database page.';
  }
  return otherTabBusy(status);
}

// Why Generate and Delete can't start: they would stop a query that is being timed.
function dataBlocked(status: Status, running: boolean): string | null {
  if (running) return 'A query is being timed. Generate and Delete are back when it finishes.';
  const busy = status.busy?.kind;
  return busy === 'run' || busy === 'suite' || busy === 'explain' ? otherTabBusy(status) : null;
}

export function App() {
  const { status, error, refresh } = useStatus();
  const route = useRoute();
  const [running, setRunningState] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  // Re-read the status when a run ends, so a stale "busy" from the poll clears at once.
  const setRunning = useCallback(
    (next: boolean) => {
      setRunningState(next);
      if (!next) refresh();
    },
    [refresh],
  );

  const onFinished = useCallback((result: RunResult, info: HistoryInfo) => {
    setHistory((current) => addHistory(result, info, current));
  }, []);

  // Another tab ran or cleared something: show its list here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === HISTORY_KEY || e.key === null) setHistory(loadHistory());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Move focus to the new page's heading, so keyboard and screen-reader users land on it.
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    document.querySelector<HTMLElement>(`[data-page="${route}"] h1`)?.focus({ preventScroll: true });
  }, [route]);

  if (!status) {
    return (
      <div className="connecting">
        {error ? (
          <div className="banner bad">
            <p>
              <b>Can’t reach the web server.</b> {error} Retrying…
            </p>
          </div>
        ) : (
          <p className="row muted">
            <span className="spinner" aria-hidden /> Connecting…
          </p>
        )}
      </div>
    );
  }

  // Pages stay mounted while hidden, so a run keeps going and each page keeps its state.
  const page = (name: Route) => ({ 'data-page': name, hidden: route !== name });

  return (
    <div className="app">
      <header className="top">
        <Versus />
        <Nav route={route} />
      </header>
      <main className={`page page-${route}`}>
        {error && (
          <div className="banner bad">
            <p>
              <b>Lost contact with the web server.</b> {error} Retrying…
            </p>
          </div>
        )}
        <div {...page('data')}>
          <DatabasePage status={status} refresh={refresh} blocked={dataBlocked(status, running)} active={route === 'data'} />
        </div>
        <div {...page('run')}>
          <RunPage
            status={status}
            blocked={runBlocked(status)}
            running={running}
            setRunning={setRunning}
            onFinished={onFinished}
          />
        </div>
        <div {...page('history')}>
          <HistoryPage entries={history} onClear={() => setHistory(clearHistory())} active={route === 'history'} />
        </div>
      </main>
    </div>
  );
}
