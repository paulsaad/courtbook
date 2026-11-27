#!/usr/bin/env bash
# Build (locally, never pushed) the staging website "WP" = WE + the approved pilot line, and refuse anything that would
# drop staging-web's deletion-retry schedule. LOCAL ONLY: no push, no deploy.
#   bash docs/ops/staging-web-wp.sh <pilot ref, e.g. origin/int/pilot-26nov> [WE commit, default b85b566]
#   bash docs/ops/staging-web-wp.sh --check <any ref>     # only the guard: is this ref safe to put on staging-web?
# The guard: the files that carry the schedule (vercel.json cron, the retry route's Sentry check-ins, the monitor and
# its test) must be byte-identical to origin/staging-web's. int/pilot-26nov(-staging) fails it, by design.
set -euo pipefail
SCHEDULE_FILES=(vercel.json src/lib/deletion/monitor.ts src/lib/deletion/schedule.test.ts src/app/api/internal/deletions/retry/route.ts)
guard() {
  local ref=$1 bad=0
  for f in "${SCHEDULE_FILES[@]}"; do
    if git diff --quiet origin/staging-web "$ref" -- "$f"; then echo "  same as staging-web: $f"; else echo "  DIFFERS from staging-web: $f"; bad=1; fi
  done
  grep -q '"/api/internal/deletions/retry"' <(git show "$ref:vercel.json") || { echo "  no deletion-retry cron in vercel.json"; bad=1; }
  return $bad
}
git fetch -q origin staging-web
if [ "${1:-}" = "--check" ]; then
  if guard "$2"; then echo "SAFE for staging-web: the deletion schedule is kept"; else echo "REFUSED: deploying $2 to staging-web would change or drop the deletion schedule"; exit 1; fi
  exit 0
fi
PILOT=${1:?pilot ref}; WE=${2:-b85b566}
work=$(mktemp -d); git worktree add -q --detach "$work" "$WE"
trap 'git worktree remove --force "$work" >/dev/null 2>&1 || true' EXIT
( cd "$work"
  git -c user.name=Claude -c user.email=noreply@anthropic.com merge --no-ff "$PILOT" -m "WP: the approved pilot website ($(git rev-parse --short "$PILOT")) on WE, keeping staging-web's deletion schedule" >/dev/null 2>&1 || true
  conflicts=$(git diff --name-only --diff-filter=U)
  # the one known conflict: a test file; staging-web's side keeps the monitor-aware clock and the Sentry monitor tests
  [ -z "$conflicts" ] || [ "$conflicts" = "src/app/api/account/deletionRoutes.test.ts" ] || { echo "unexpected conflicts: $conflicts"; exit 2; }
  if [ -n "$conflicts" ]; then
    python3 - <<'PY'
import re
p='src/app/api/account/deletionRoutes.test.ts'; s=open(p).read()
s=re.sub(r'<<<<<<< HEAD\n(.*?)=======\n.*?>>>>>>> [^\n]*\n', r'\1', s, flags=re.S)
assert '<<<<<<<' not in s; open(p,'w').write(s)
PY
    git add src/app/api/account/deletionRoutes.test.ts
    git -c user.name=Claude -c user.email=noreply@anthropic.com commit -q --no-edit
  fi
  echo "WP commit $(git rev-parse --short HEAD), tree $(git rev-parse HEAD^{tree})"
  echo "differs from the pilot line only in:"; git diff --name-only "$PILOT" HEAD | sed 's/^/  /'
  guard HEAD || { echo "WP FAILS the guard"; exit 1; }
  git branch -f wp-local HEAD >/dev/null   # kept locally for inspection; never pushed by this script
  echo "local branch wp-local → $(git rev-parse --short HEAD) (not pushed)"
)
