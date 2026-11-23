#!/usr/bin/env bash
# Runs a read-only check file (supabase/live/*.sql) and FAILS (exit 1) unless every required row is ok.
#   run-check.sh <db url> <file> <required>
#     required = part1 : rows are part|item|ok|detail; every part-1 row must be ok (part 2 is information)
#     required = all   : rows are item|ok|detail; every row must be ok
# The whole result is printed either way. No rows, or a psql error, is a failure too.
set -uo pipefail
db=$1; file=$2; required=$3
out=$(psql "$db" -X -v ON_ERROR_STOP=1 -At -F '|' -c "set default_transaction_read_only = on" -f "$file" 2>&1) \
  || { echo "$out"; echo "::error::$file could not run"; exit 1; }
rows=$(echo "$out" | grep '|' || true)
[ -n "$rows" ] || { echo "$out"; echo "::error::$file returned no rows"; exit 1; }
case $required in
  part1) echo "$rows" | awk -F'|' '{ d = $4; for (i = 5; i <= NF; i++) d = d "|" $i; printf "%-6s [part %s] %s%s\n", $3 == "t" ? "ok" : "FAIL", $1, $2, d == "" ? "" : "  — " d }'
         [ -n "$(echo "$rows" | awk -F'|' '$1 == "1"')" ] || { echo "::error::$file returned no part-1 rows"; exit 1; }
         bad=$(echo "$rows" | awk -F'|' '$1 == "1" && $3 != "t" { print $2 }') ;;
  all)   echo "$rows" | awk -F'|' '{ d = $3; for (i = 4; i <= NF; i++) d = d "|" $i; printf "%-6s %s%s\n", $2 == "t" ? "ok" : "FAIL", $1, d == "" ? "" : "  — " d }'
         bad=$(echo "$rows" | awk -F'|' '$2 != "t" { print $1 }') ;;
  *) echo "::error::unknown mode $required"; exit 2 ;;
esac
if [ -n "$bad" ]; then
  echo "::error::$(basename "$file"): $(echo "$bad" | wc -l) required check(s) failed: $(echo "$bad" | paste -sd ';' -)"
  exit 1
fi
echo "$(basename "$file"): every required check ok"
