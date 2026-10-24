import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from './api';
import type { LifecycleState, Status } from '../shared/types';

// How often /api/status is polled. Background jobs are polled fast so progress feels live.
function pollDelay(state: LifecycleState | null, failed: boolean): number {
  if (document.hidden) return 15_000;
  if (failed) return 2_000;
  if (state === 'seeding' || state === 'deleting') return 500;
  if (state === 'starting' || state === null) return 1_000;
  return 5_000;
}

export function useStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let next: Status | null = null;
      try {
        next = await api.status(ctrl.signal);
        setStatus(next);
        setError(null);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      }
      if (!ctrl.signal.aborted) timer = setTimeout(load, pollDelay(next?.state ?? null, next === null));
    };
    void load();
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [nonce, refresh]);

  return { status, error, refresh };
}

// localStorage can throw (private windows, blocked storage), so every access is guarded.
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saved; the page works without it.
  }
}

export type Route = 'data' | 'run' | 'history';
const ROUTES: Route[] = ['data', 'run', 'history'];

function readRoute(): Route {
  const r = location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(r as Route) ? (r as Route) : 'run';
}

// The page lives in the URL hash (#/data, #/run, #/history), so Back and reload work.
// With no hash, the app opens on Run.
// Each page remembers how far down it was scrolled. The browser's own restore is off: on
// Back it scrolls before hashchange fires, so the page being left would save the wrong spot.
if (typeof history !== 'undefined' && 'scrollRestoration' in history) history.scrollRestoration = 'manual';

export function useRoute() {
  const [route, setRoute] = useState<Route>(readRoute);
  const current = useRef(route);
  const scrolls = useRef<Partial<Record<Route, number>>>({});

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      if (next === current.current) return;
      scrolls.current[current.current] = window.scrollY;
      current.current = next;
      setRoute(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, scrolls.current[route] ?? 0);
  }, [route]);

  return route;
}
