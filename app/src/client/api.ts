// Calls to the server. A run answers with an event stream on the POST response,
// which EventSource can't read, so the stream is parsed here.

import type { ApiError, PresetId, RunEvent, RunRequest, RowsResponse, Status } from '../shared/types';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly busy: ApiError['busy'] = null,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return (await readJson(res)) as T;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page or similar.
  }
  if (!res.ok) {
    const err = data as ApiError | null;
    throw new RequestError(err?.error ?? `The server answered ${res.status}.`, res.status, err?.busy ?? null);
  }
  return data;
}

const live = {
  status: (signal?: AbortSignal) => request<Status>('GET', '/api/status', undefined, signal),
  seed: (preset: PresetId) => request<{ ok: true }>('POST', '/api/dataset', { preset }),
  deleteAll: () => request<{ ok: true }>('DELETE', '/api/dataset'),
  recheck: () => request<{ ok: true }>('POST', '/api/recheck', {}),
  rows: (table: string, page: number, pageSize: number, signal?: AbortSignal) =>
    request<RowsResponse>(
      'GET',
      `/api/dataset/rows?table=${encodeURIComponent(table)}&page=${page}&pageSize=${pageSize}`,
      undefined,
      signal,
    ),
  run: (body: RunRequest, onEvent: (e: RunEvent) => void) => streamEvents('/api/run', body, onEvent),
};

export type Api = typeof live;

// The demo build (vite build --mode demo) has no server: it replays recorded runs instead.
// The normal build drops this import with the branch below, so it has none of the demo or its
// recordings; the demo build bundles it into its one script (vite.config.ts).
function demo(): Api {
  const real = import('./demo/api').then((m) => m.demoApi);
  const call = (key: keyof Api) => (...args: unknown[]) => real.then((a) => (a[key] as (...a: unknown[]) => unknown)(...args));
  return Object.fromEntries(Object.keys(live).map((key) => [key, call(key as keyof Api)])) as unknown as Api;
}

export const api: Api = import.meta.env.MODE === 'demo' ? demo() : live;

// Posts `body` and calls onEvent for each "data: …" event until the stream ends.
async function streamEvents<E>(url: string, body: unknown, onEvent: (e: E) => void): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    await readJson(res);
    throw new RequestError('The server sent no data.', res.status);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}
