#!/usr/bin/env bash
# Builds the disposable LOCAL database `courtbook_audit` from the migrations and seed of a git ref.
# Default ref: origin/mobile-m2-native — the branch whose migrations (0001–0066) match what is
# applied on live (0065/0066 were applied on 14 Nov and reach main with the M2 merge).
# Read-only use of the ref (git archive); nothing on any branch is changed. Ref WORKTREE = the files
# as they are in this checkout (uncommitted changes included). DB=<name> overrides the database name.
#   PSQL="sudo -u postgres psql" bash supabase/tests/audit/build_db.sh [ref]
set -euo pipefail
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
REF=${1:-origin/mobile-m2-native}
DB=${DB:-courtbook_audit}
where=$($PSQL -At -d postgres -c "select coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in local-socket|127.0.0.1|::1) ;; *) echo "refusing: not a local Postgres ($where)"; exit 2;; esac
work=$(mktemp -d); chmod 755 "$work"; trap 'rm -rf "$work"' EXIT
if [ "$REF" = WORKTREE ]; then mkdir -p "$work/supabase"; cp -r supabase/migrations supabase/seed.sql "$work/supabase/"
else git archive "$REF" supabase/migrations supabase/seed.sql | tar -x -C "$work"; fi
cp supabase/tests/supabase_shim.sql "$work/shim.sql"
chmod -R a+rX "$work"
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f "$work/shim.sql" >/dev/null
n=0
for f in $(ls "$work"/supabase/migrations/*.sql | sort); do
  $PSQL -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null 2>&1 || { echo "MIGRATION FAILED: $(basename "$f")"; exit 1; }
  n=$((n+1))
done
$PSQL -q -d $DB -v ON_ERROR_STOP=1 -f "$work/supabase/seed.sql" >/dev/null
if [ "$REF" = WORKTREE ]; then label="working tree ($(git rev-parse --short HEAD)+changes)"; else label="$REF ($(git rev-parse --short "$REF"))"; fi
echo "$DB built from $label: $n migrations + seed"
