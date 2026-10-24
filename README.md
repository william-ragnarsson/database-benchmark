# Postgres vs ClickHouse

A small website that runs the same SQL on Postgres and on ClickHouse and shows how long each one took.

Both databases hold the same generated data: realistic-looking users (names, emails, cities) and their orders. The data is generated on your machine when you press Generate, so nothing large is downloaded or stored in git. By default it takes about 165 MB, and one script removes everything again.

- **Database.** Pick a size, press Generate, and page through each table's rows, 20 at a time. Delete removes the data again.
- **Run.** Pick one of 13 queries and press Run: aggregations, time series, distinct counts and percentiles, joins, text search, and two lookups where Postgres wins. Each engine gets one warm-up run, then up to 5 timed runs (just 1 if the warm-up took over a second), taking turns. The page shows the median of each, how many times faster the winner was, and whether both returned the same rows.
- **History.** Your last 50 runs, kept in this browser.

Everything runs in containers on your own machine. Only the website is reachable, and only from your own machine (`127.0.0.1`).

There is also a [static demo](#the-static-demo) that needs no Docker. It replays results recorded on a real stack.

## Quick start

You need Docker or Podman. Either one works. If you don't have either, see [What are Docker and Compose?](#what-are-docker-and-compose)

### With Docker Desktop or OrbStack

```bash
git clone https://github.com/william-ragnarsson/database-benchmark.git
cd database-benchmark
docker compose up --build
```

### With Podman (macOS)

Podman needs a small Linux VM on a Mac. Do these steps once:

1. Install Podman and Compose:

   ```bash
   brew install podman docker-compose
   ```

   `podman compose` runs `docker-compose` behind the scenes. `podman-compose` also works if you already have it.

2. Create and start the VM, with 4 CPUs, 6 GB of memory and a disk of up to 20 GB:

   ```bash
   podman machine init --cpus 4 --memory 6144 --disk-size 20
   ```

   The disk grows as it is used, so nothing is reserved up front.

   ```bash
   podman machine start
   ```

Then start the app:

```bash
git clone https://github.com/william-ragnarsson/database-benchmark.git
cd database-benchmark
podman compose up --build
```

On Linux, Podman runs without a VM. Install `docker-compose` or `podman-compose`, skip the machine steps, and run `podman compose up --build`.

### The first run

- **The first start takes a few minutes.** It downloads about 450 MB of images and builds the website. Later starts take a few seconds.
- **Wait for the ready line.** When this line appears, open the address:

  ```
  Ready → http://localhost:8080
  ```

- **Generate the data first.** The app opens on Run. Go to Database, pick a size and press Generate. Standard takes about 8 seconds.
- **The data is kept between restarts.** Stop the app with Ctrl+C, or with `docker compose down`. The next `up` starts where you left off.
- **To run it in the background,** add `-d`. Stop it later with `docker compose down`.
- **If port 8080 is already in use,** copy `.env.example` to `.env` and change `WEB_PORT`.

## What are Docker and Compose?

- **A container** is a sealed box that holds one program plus everything it needs, such as the Postgres server and its libraries. It runs the same on every computer and doesn't install anything into your system.
- **An image** is the downloadable template a container is started from, like `postgres:18-alpine`.
- **An engine** downloads images and runs containers. Containers need Linux, so on macOS and Windows the engine runs inside a small Linux VM.
- **Docker Desktop, OrbStack and Podman** each give you an engine. You need only one:
  - **Docker Desktop** is Docker's own app.
  - **OrbStack** is a lighter Mac app that runs the same Docker engine.
  - **Podman** is a separate, free engine. On a Mac, `podman machine` creates its VM.
- **The `docker` command is only a client.** It sends instructions to whichever engine it is pointed at, and does nothing if none is running. Homebrew's `docker` package is just this client.
- **Compose** starts several containers together from one file. This project's [`docker-compose.yml`](docker-compose.yml) has three: `postgres`, `clickhouse` and `web` (this website). It also creates two storage volumes that hold the database files.

So `compose up --build` does three things: it downloads the two database images, builds the website image from [`app/`](app/), and starts all three containers. You don't install Postgres, ClickHouse or Node.js yourself.

## Sizes

You pick a size on the **Database** page and press **Generate**. To change it, pick another size and press Generate again.

| Size | Orders / users | Disk (both engines) | Generating takes |
|---|---|---|---|
| Light | 250k / 50k | ~75 MB | ~4 s |
| **Standard (default)** | **1M / 100k** | **~165 MB** | **~8 s** |
| Large | 5M / 200k | ~620 MB (up to ~760 MB for a few seconds while loading) | ~40 s |

Measured with Podman on an Apple Silicon Mac, with 4 CPUs per engine.

- **Most of the space is Postgres.** At Standard, Postgres uses 147 MB and ClickHouse 14 MB for the same rows, because ClickHouse compresses each column.
- **Generating a new size deletes the old data first,** so the old and new data are never on disk together. While loading, use briefly goes a little above the size (Large: up to ~760 MB).

## What to expect

These are the medians at Standard (1M orders, 100k users), with warm data:

| Template | Postgres | ClickHouse | |
|---|---:|---:|---|
| Running monthly revenue | 188 ms | 13 ms | ClickHouse 14× faster |
| Median & p90 price by category | 181 ms | 18 ms | ClickHouse 10× faster |
| Busiest customer-days | 405 ms | 42 ms | ClickHouse 9.8× faster |
| Distinct buyers per month in 2025 | 118 ms | 15 ms | ClickHouse 8.1× faster |
| Top 10 customers by spend | 168 ms | 29 ms | ClickHouse 5.7× faster |
| Daily orders & revenue, Mar–May 2025 | 19 ms | 7 ms | ClickHouse 2.7× faster |
| Card share by country | 67 ms | 28 ms | ClickHouse 2.4× faster |
| Revenue by category | 29 ms | 13 ms | ClickHouse 2.3× faster |
| Revenue by country | 69 ms | 30 ms | ClickHouse 2.3× faster |
| Users by signup year & plan | 9 ms | 6 ms | about the same |
| Email + city search | 1.6 ms | 4.8 ms | Postgres 3.1× faster |
| Order #242424 | 0.4 ms | 6 ms | Postgres 16× faster |
| Customer 4242's last 20 orders | 0.4 ms | 8 ms | Postgres 18× faster |

- **ClickHouse wins scans and aggregations.** It reads only the columns a query needs, in compressed blocks, using all 4 threads.
- **Postgres wins lookups.** It has a B-tree index on the lookup column, and its fixed cost per query is about 0.2 ms, against about 2.5 ms for ClickHouse.
- **At this size most queries still finish in well under a second on both.** Pick Large to see the same gap at a size where you can feel it: heavy queries take Postgres 0.1–3 s and ClickHouse 15–130 ms.

## How it measures

- **Same resources.** Both engines get 4 CPUs and 2 GB of memory, and 4 threads per query: ClickHouse uses `max_threads=4`, and Postgres uses its main process plus 3 parallel workers.
- **One engine at a time.** The two never run at the same time. Runs alternate between them: PG CH CH PG PG CH…
- **What a timing covers.** The time from sending the query until the last row has been read, measured by the web server. Results are cut off at 101 rows, so sending rows back doesn't decide the race.
- **No caches that skip the work.** ClickHouse's query cache and query-condition cache are off and locked. Data is warm in memory on both, because of the warm-up run.
- **Read-only.** Both connections use read-only users. Only a single `SELECT` or `WITH` query is accepted, and the guard also checks for data-changing statements hidden inside it.
- **Limits.** Each query stops after 30 s. ClickHouse may use up to 1 GB of memory per query and return at most 10,000 rows or 64 MB. Each engine may spill at most about 500 MB to temporary files.

## Footprint and uninstall

**What it uses on disk:**

| What | Size | Removed by |
|---|---|---|
| Generated data | ~165 MB at Standard | **Delete data…** on the Database page, or `./uninstall.sh` |
| The empty databases | ~40 MB | `./uninstall.sh` |
| Images (Postgres, ClickHouse, Node.js, the website) | ~1.3 GB | `./uninstall.sh` |
| Build cache | a few hundred MB | see step 3 below |

**To remove everything:**

1. Remove the containers, the data volumes and this project's images:

   ```bash
   ./uninstall.sh
   ```

   The script checks both Docker and Podman and cleans each one that has something of this project. Run `ENGINE=podman ./uninstall.sh` (or `ENGINE=docker`) to clean only one. It keeps an image that a container of another project still uses, and at the end it checks that nothing is left.

2. Delete the folder.

3. Optional. These affect your whole machine, so the script only prints them:
   - **Docker:** `docker builder prune` clears the build cache.
   - **Podman:** if you created the Podman machine only for this, run `podman machine rm`. That removes the VM and everything in it. `podman machine reset` also removes the downloaded VM images.
   - **Docker Desktop:** Troubleshoot → Clean / Purge data.

If the script can't run, remove the data by hand with `docker volume rm pg-vs-ch_pgdata pg-vs-ch_chdata` (or `podman volume rm …`).

### Getting the space back on a Mac

On a Mac, the containers live inside a VM, and the VM's disk file doesn't shrink on its own when you delete data. To hand the space back to macOS:

```bash
podman machine ssh sudo fstrim -av
```

In testing, this shrank the VM's disk file from 11.2 GB to 4.2 GB. Docker Desktop and OrbStack reclaim space on their own, which can take a few minutes.

### Updating

```bash
git pull
docker compose up --build
```

Each rebuild leaves the previous website image behind. Remove the old ones with:

```bash
docker image prune -f --filter label=app=pg-ch-bench
```

Use `podman` instead of `docker` with Podman.

## Troubleshooting

**`unknown flag: --build`, or `docker: unknown command: docker compose`**

Your `docker` command doesn't have the Compose plugin. This happens with the `docker` client from Homebrew, or when links left over from an uninstalled Docker Desktop point at nothing. Docker Desktop and OrbStack include Compose. With Podman, run `podman compose up --build` instead, as in the quick start.

To make `docker compose` itself work with Homebrew's Compose, install it and tell `docker` where Homebrew puts plugins, by adding this line inside `~/.docker/config.json`:

```bash
brew install docker-compose
```

```json
"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
```

**`Cannot connect to the Docker daemon`, or `failed to connect to the docker API at unix://…`**

No container engine is running. The `docker` command is only a client. Start Docker Desktop or OrbStack. With Podman, either use `podman compose`, or point `docker` at the Podman VM once:

```bash
docker context create podman --docker "host=unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}')"
```

```bash
docker context use podman
```

To switch back later, run `docker context use default` (or `orbstack`, `desktop-linux`). `docker context ls` lists them.

**`error getting credentials … docker-credential-osxkeychain: executable file not found`**

Your `~/.docker/config.json` names a credential helper that is no longer installed. This often happens after uninstalling Docker Desktop. There are three ways out:

- **Drop it (simplest):** remove the `"credsStore"` line from that file. The images used here don't need a login.
- **Keep your saved Docker Hub login:** run `brew install docker-credential-helper`. The next build shows one macOS keychain prompt per saved login; choose Always Allow on each.
- **Skip it for one command:** point Compose at an empty config folder:

  ```bash
  mkdir -p /tmp/empty-docker-config && DOCKER_CONFIG=/tmp/empty-docker-config podman compose up --build
  ```

**`error getting credentials … User canceled the operation. (-128)`, or the keychain prompt keeps coming back**

macOS is asking whether `docker-credential-osxkeychain` may read your saved Docker logins. When building, Compose reads every saved login, and macOS asks once for each one. Clicking Allow instead of Always Allow means it asks again on the next build.

This app doesn't need a login. To stop the prompts, run `brew uninstall docker-credential-helper` and remove the `"credsStore"` line from `~/.docker/config.json`. You need both steps: while that helper is installed, Docker uses it even without the `credsStore` line. Your saved logins stay in the keychain. To use them again later, reinstall the helper and put the line back.

**The page says "Starting the databases…" for a long time.** The first start of each database takes up to half a minute. If it doesn't clear, check the logs with `docker compose logs postgres clickhouse`.

**`range of CPUs is from 0.01 to N` or a similar error.** Each database asks for 4 CPUs. Give Docker Desktop at least 4 CPUs and 6 GB of memory under Settings → Resources. With Podman, use `podman machine init --cpus 4 --memory 6144`. To change an existing machine, run `podman machine stop`, then `podman machine set --cpus 4 --memory 6144`, then start it again.

**A Bake or buildx warning while building.** It is harmless.

**You changed a file in `db/clickhouse/`.** Restart ClickHouse with `docker compose restart clickhouse`. Those files are mounted one at a time, so the container sees edits only after a restart.

**Port 8080 is taken.** Copy `.env.example` to `.env` and set `WEB_PORT=8081`, for example.

## The static demo

`npm run build:demo` builds a version of the website that needs no server, for static hosting such as Vercel. It doesn't run queries. It replays real ones:

- **Every query on every size was run once** on a real stack, and each run's progress was saved with its timing. Pressing Run replays it at the pace it happened. Generate and Delete replay their recorded progress too.
- **The table rows are made in the browser** by the same seeded generator, so they are the rows the databases held. No table data is shipped: the recordings are about 190 KB, or 35 KB compressed.
- **A bubble at the top right says the results are recorded.** Hover over it or tap it for the date and how to run it yourself.

The normal build doesn't include any of this.

**To try it locally:**

```bash
cd app
npm install
npm run build:demo
npm run preview:demo
```

Then open http://localhost:4173.

**To put it on Vercel,** import the repository as a new project, set **Root Directory** to `app`, and deploy. [`app/vercel.json`](app/vercel.json) holds the rest: it builds the demo and serves `app/dist/demo`. Vercel only reads it from the Root Directory, so it must stay `app`.

**To record it again,** for example after changing a query or the generator, start the stack with `docker compose up --build`, so it runs your current code, and run (Node 22.18 or newer; on Node 23, 23.6 or newer):

```bash
cd app
node scripts/record-demo.ts
```

It generates each size, runs every query on it with 5 timed runs, and writes `app/src/client/demo/recordings/`, plus two files in `app/test/fixtures/` that the tests check the demo against. Commit them together. It takes a few minutes and leaves Standard loaded. If you changed `WEB_PORT`, give the address: `node scripts/record-demo.ts http://localhost:8081`.

`npm test` fails if the recording is out of date (a query or a size changed since, or a query is new), or if the rows made in the browser differ from the ones the stack returned.

## Development

The website is TypeScript: a Fastify server and a React client, in [`app/`](app/).

```bash
cd app
npm install
npm test          # unit tests (vitest)
npm run check     # type check
```

After a code change, rebuild just the website with `docker compose up --build -d web`.

**Layout:**

| Path | What it holds |
|---|---|
| `app/src/server/seed/` | data generator, seeding and size measurement |
| `app/src/server/bench/` | the query guard, the run loop and the result comparison |
| `app/src/shared/templates.ts` | the 13 templates, with Postgres and ClickHouse SQL |
| `app/src/client/` | the website: the Database, Run and History pages |
| `app/src/client/demo/` | the static demo: replaying the recordings, and making rows in the browser |
| `app/scripts/record-demo.ts` | records the static demo from a running stack |
| `db/clickhouse/` | ClickHouse's low-footprint config and its read-only user |

The generator is seeded, so every machine gets the same rows. If you change what it produces, bump `GENERATOR_VERSION` in `generator.ts`. Existing data then shows as out of date, and the Database page asks you to generate it again.
