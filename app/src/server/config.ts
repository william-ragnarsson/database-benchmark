// Everything the server reads from the environment. docker-compose.yml sets these; the
// defaults match it, so the server also runs on the host against published ports.

import { fileURLToPath } from 'node:url';

const env = process.env;

export const config = {
  listenHost: env.LISTEN_HOST ?? '0.0.0.0',
  listenPort: Number(env.PORT ?? 8080),
  // The host port Compose publishes. Used for the "Ready →" line and the Host-header check.
  webPort: Number(env.WEB_PORT ?? 8080),
  clientDir: env.CLIENT_DIR ?? fileURLToPath(new URL('../client', import.meta.url)),
  // Host names the page may be opened under, besides localhost. Requests for any other name are
  // refused, so a web page elsewhere can't reach this server through DNS tricks.
  extraHosts: (env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  pg: {
    host: env.PG_HOST ?? 'localhost',
    port: Number(env.PG_PORT ?? 5432),
    user: env.PG_USER ?? 'bench',
    password: env.PG_PASSWORD ?? 'bench',
    readerUser: 'bench_ro',
    readerPassword: env.PG_READER_PASSWORD ?? 'reader',
  },
  ch: {
    url: env.CH_URL ?? 'http://localhost:8123',
    user: env.CH_USER ?? 'bench',
    password: env.CH_PASSWORD ?? 'bench',
    readerUser: 'reader',
    readerPassword: env.CH_READER_PASSWORD ?? 'reader',
  },
};
