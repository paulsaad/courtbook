#!/usr/bin/env bash
# Website ↔ database stage compatibility (review of #61, 25 Nov). LOCAL ONLY: never touches staging.
#
# For each "<website commit>:<stage>:<reference stage>" argument: every Supabase call in that website's src/ (tests
# excluded) — .from() chains with their select lists, embeds, filters, order, insert/update/upsert keys and delete, and
# .rpc() with its argument names — is checked against a scratch database migrated to <stage> (0001..<stage> from this
# checkout, on the repository's Supabase shim): the relation or function exists, every column exists, the privilege is
# granted (table or column level) to anon, authenticated and service_role, RLS has a permissive policy for the command,
# and an rpc signature takes exactly those argument names with EXECUTE granted. Any verdict that differs from the
# reference stage is reported. Calls whose input is not a literal are listed for a manual look (manual.json holds the
# hand-resolved ones). controls.json are deliberately wrong calls that must be caught.
#
#   REPO_ROOT=$PWD bash .github/tests/website-stage-compat/run.sh 59a2f11:0089:0086 6e499a5:0089:0092 ...
# Needs: local PostgreSQL (psql as the postgres user through sudo), node, and npm ci (for typescript).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); root=${REPO_ROOT:-$(cd "$here/../../.." && pwd)}
work=$(mktemp -d); chmod 755 "$work"; export CATALOG_DIR=$work
trap 'rm -rf "$work"' EXIT
PSQL="sudo -u postgres psql -X -q"
stages=$(for a in "$@"; do IFS=: read -r _ s r <<<"$a"; echo "$s"; echo "$r"; done | sort -u)
for S in $stages; do
  db=compat_$S
  $PSQL -d postgres -c "drop database if exists $db" -c "create database $db" >/dev/null 2>&1
  $PSQL -d $db -v ON_ERROR_STOP=1 -f /dev/stdin <"$root/supabase/tests/supabase_shim.sql" >/dev/null
  for f in $(ls "$root"/supabase/migrations/*.sql | sort); do
    n=$(basename "$f"); [[ "${n:0:4}" > "$S" ]] && continue
    $PSQL -d $db -v ON_ERROR_STOP=1 -1 -f /dev/stdin <"$f" >/dev/null || { echo "stage $S: $n failed"; exit 2; }
  done
  $PSQL -At -d $db -f /dev/stdin <"$here/catalog.sql" >"$work/cat_$S.json"
  $PSQL -d postgres -c "drop database $db" >/dev/null 2>&1
done
python3 "$here/check.py" "$here/controls.json" 0092 0092 >"$work/controls.txt" 2>&1 || true
grep -q "MISSING at this stage (relation, column or function): 2" "$work/controls.txt" \
  && grep -q "refused for the role the call uses .*: 3" "$work/controls.txt" \
  || { echo "CONTROLS NOT CAUGHT — the checker is not trustworthy:"; cat "$work/controls.txt"; exit 2; }
echo "controls: all deliberately wrong calls caught"
bad=0
for a in "$@"; do
  IFS=: read -r ref s r <<<"$a"
  mkdir -p "$work/$ref"; git -C "$root" archive "$ref" src | tar -x -C "$work/$ref"
  REPO_ROOT=$root node "$here/extract.mjs" "$work/$ref/src" >"$work/$ref.raw.json"
  python3 - "$work/$ref.raw.json" "$here/manual.json" "$work/$ref.json" <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); man = json.load(open(sys.argv[2]))
keep = [x for x in c if not ((x["kind"] == "rpc" and x["fn"] is None) or (x.get("unresolved") and x["kind"] == "rpc"
        and x["fn"] in ("club_discovery", "open_matches")) or any(o.get("unresolved") for o in x.get("ops", [])))]
json.dump(keep + man, open(sys.argv[3], "w"))
PY
  out=$(python3 "$here/check.py" "$work/$ref.json" "$s" "$r"); echo "$out"
  echo "$out" | grep -E "^- (MISSING|REGRESSION|refused|needs)" | grep -vq ": 0$" && bad=1
done
exit $bad
