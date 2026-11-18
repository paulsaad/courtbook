#!/usr/bin/env bash
# Runs clubMode.regression.mjs against a throwaway local PostgreSQL cluster, removed afterwards.
#   bash mobile/e2e/test-club-mode.sh
set -euo pipefail
cd "$(dirname "$0")"
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
TMP=$(mktemp -d); PORT=${PORT:-55432}
trap '"$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
if [ "$(id -u)" = 0 ]; then RUN=(runuser -u postgres --); chown postgres "$TMP"; else RUN=(); fi
"${RUN[@]}" "$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -p $PORT -c listen_addresses=''" -w start >/dev/null
CLUBMODE_TEST_DB="postgresql://postgres@/postgres?host=$TMP&port=$PORT" node --test clubMode.regression.mjs
