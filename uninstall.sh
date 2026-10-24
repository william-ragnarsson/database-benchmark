#!/bin/sh
# Removes everything this project created: containers, data volumes and images.
# Afterwards you can delete this folder.
#
# Cleans each engine (docker, podman) that has something of this project.
# Set ENGINE=docker or ENGINE=podman to clean only that one.
set -u
cd "$(dirname "$0")"

PROJECT=pg-vs-ch
LABEL=app=pg-ch-bench
DB_IMAGES="docker.io/library/postgres:18-alpine docker.io/clickhouse/clickhouse-server:26.8-alpine"
NODE_IMAGE=docker.io/library/node:22-alpine

reachable() { command -v "$1" >/dev/null 2>&1 && "$1" info >/dev/null 2>&1; }

# What is left of this project in engine $1, one line per thing. Empty when it is all gone.
leftovers() {
  {
    "$1" ps -a --filter "label=com.docker.compose.project=$PROJECT" --format 'container {{.Names}}'
    "$1" volume ls --filter "label=com.docker.compose.project=$PROJECT" --format 'volume {{.Name}}'
    "$1" volume ls --format 'volume {{.Name}}' | grep "^volume ${PROJECT}_"
    "$1" images -a --filter "label=$LABEL" --format 'image {{.ID}} {{.Repository}}:{{.Tag}}'
  } 2>/dev/null | sort -u
}

# Removes an image if it is there. image rm refuses while any container still uses it.
remove_image() {
  "$1" image inspect "$2" >/dev/null 2>&1 || return 0
  "$1" image rm "$2" >/dev/null 2>&1 || echo "  (kept $2: a container of another project still uses it)"
}

clean() {
  e=$1
  echo "→ $e: removing containers, data volumes and images…"
  # --rmi all fails as a whole if an image is still in use elsewhere, so retry without it.
  "$e" compose down -v --rmi all --remove-orphans 2>/dev/null \
    || "$e" compose down -v --remove-orphans

  # Fallbacks in case compose couldn't run (no compose provider, …). Quiet when already gone.
  ids=$("$e" ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)
  [ -n "$ids" ] && "$e" rm -f $ids >/dev/null 2>&1
  vols=$(leftovers "$e" | sed -n 's/^volume //p')
  [ -n "$vols" ] && "$e" volume rm -f $vols >/dev/null 2>&1

  echo "→ $e: removing this app's images…"
  # -a also takes the tagged website image, not only the untagged build stages.
  "$e" image prune -af --filter "label=$LABEL" >/dev/null 2>&1
  for img in $DB_IMAGES $NODE_IMAGE; do
    remove_image "$e" "$img"
  done
}

if [ -n "${ENGINE:-}" ]; then
  candidates=$ENGINE
else
  candidates="docker podman"
fi

checked=""
cleaned=""
for e in $candidates; do
  command -v "$e" >/dev/null 2>&1 || continue
  if ! reachable "$e"; then
    echo "$e is installed but not running, so it was not checked."
    [ "$e" = podman ] && echo "  Start it with 'podman machine start' and run this again if you used it here."
    continue
  fi
  checked="$checked $e"
  # One engine can answer as both (podman's docker shim); the second pass then finds nothing.
  [ -n "$(leftovers "$e")" ] || continue
  clean "$e"
  cleaned="$cleaned $e"
done

if [ -z "$checked" ]; then
  echo "No running docker or podman was found, so nothing could be removed."
  exit 1
fi
if [ -z "$cleaned" ]; then
  echo "Nothing of this project is left in:$checked."
fi

status=0
for e in $checked; do
  left=$(leftovers "$e")
  [ -z "$left" ] && continue
  echo "✗ $e still has:"
  echo "$left" | sed 's/^/    /'
  status=1
done
[ "$status" -eq 0 ] || exit 1

echo
echo "Done. These affect your whole machine, so they are not run automatically:"
for e in $checked; do
  if [ "$e" = docker ]; then
    echo "  docker builder prune      # clears Docker's build cache"
  else
    echo "  podman system prune       # clears unused images and build cache"
    echo "  podman machine rm         # only if you created the Podman machine just for this"
  fi
done
