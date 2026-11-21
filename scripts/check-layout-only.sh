#!/usr/bin/env bash
# Phase I guard: a desktop-layout change may not touch booking, payment, sign-in or database code.
# Fails if, compared with BASE (default origin/main):
#   1. any file changed under supabase/, src/lib/, src/app/api/, src/app/auth/, or middleware;
#   2. any line that talks to Supabase or the server (.rpc( .from( .auth. supabase. "use server"
#      redirect( fetch( router.push/replace) was added or removed in src/ — moved lines are fine: the
#      removed and added sets must be identical. Lines listed in scripts/layout-only-allow.txt (each
#      approved, with its reason) are exempt.
#   bash scripts/check-layout-only.sh [BASE]
set -euo pipefail
BASE=${1:-origin/main}
fail=0
changed=$(git diff --name-only "$BASE"...HEAD)
bad=$(printf '%s\n' "$changed" | grep -E '^(supabase/|src/lib/|src/app/api/|src/app/auth/|src/middleware\.ts$|middleware\.ts$)' || true)
if [ -n "$bad" ]; then echo "FAIL  logic or database files changed:"; printf '  %s\n' $bad; fail=1; else echo "ok    no file under supabase/, src/lib/, src/app/api/, src/app/auth/ or middleware changed"; fi
PAT='\.rpc\(|\.from\(["`]|\.from\('"'"'|\.auth\.|supabase\.|"use server"|redirect\(|fetch\(|router\.(push|replace)\('
diffsrc=$(git diff -U0 "$BASE"...HEAD -- src ':(exclude)src/**/*.test.ts' ':(exclude)src/**/*.test.tsx')
ALLOW=$(dirname "$0")/layout-only-allow.txt
allowed() { if [ -f "$ALLOW" ]; then grep -vxF -f <(grep -v '^#' "$ALLOW" | sed '/^$/d') || true; else cat; fi; }
removed=$(printf '%s\n' "$diffsrc" | grep -E '^-[^-]' | sed 's/^-//; s/^[[:space:]]*//' | grep -E "$PAT" | allowed | sort || true)
added=$(printf '%s\n' "$diffsrc" | grep -E '^\+[^+]' | sed 's/^+//; s/^[[:space:]]*//' | grep -E "$PAT" | allowed | sort || true)
if [ "$removed" != "$added" ]; then
  echo "FAIL  lines that reach Supabase or the server were added or removed in src/:"
  diff <(printf '%s\n' "$removed") <(printf '%s\n' "$added") | sed 's/^/  /' || true
  fail=1
else
  echo "ok    no line that reaches Supabase or the server was added or removed in src/ ($(printf '%s' "$added" | grep -c . || true) moved unchanged)"
fi
[ $fail = 0 ] && echo "RESULT: layout only" || { echo "RESULT: NOT layout only"; exit 1; }
