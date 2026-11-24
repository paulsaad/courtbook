#!/usr/bin/env bash
# Runs the real "Call the staging retry route" step of .github/workflows/deletion-retry.yml against a fake curl, in
# three worlds: the staging-web alias protected by Vercel login, the alias public (a Deployment Protection Exception),
# and a broken route that accepts requests without the bearer. Nothing leaves this machine.
#   bash .github/tests/deletion-retry-probe.sh      (needs python3 with PyYAML)
# Passes when: protected and public both pass; broken fails; and no probe request ever carries the real bearer.
set -u
here=$(cd "$(dirname "$0")" && pwd); repo=$(cd "$here/../.." && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'FAKE'
#!/usr/bin/env bash
bearer=""; bypass=""; out=/dev/null
while [ $# -gt 0 ]; do case "$1" in
  -H) case "$2" in "Authorization: Bearer "*) bearer=${2#Authorization: Bearer };; "x-vercel-protection-bypass: "*) bypass=${2#x-vercel-protection-bypass: };; esac; shift 2;;
  -o) out=$2; shift 2;; -w|--proto|--max-redirs|--max-time|-X) shift 2;; *) shift;; esac; done
b=none; [ -n "$bearer" ] && b=wrong; [ "$bearer" = "$REAL_SECRET" ] && b=REAL
if [ "$MODE" = protected ] && [ -z "$bypass" ]; then code=302; to="https://vercel.com/sso-api?x=1"
elif [ "$MODE" = broken ] || [ "$b" = REAL ]; then code=200; to=""
else code=401; to=""; fi
echo "{}" > "$out"; echo "bearer=$b bypass=$([ -n "$bypass" ] && echo yes || echo no) -> $code" >> "$LOG"
printf '%s %s' "$code" "$to"
FAKE
chmod +x "$work/bin/curl"
python3 -c "import yaml,sys; y=yaml.safe_load(open(sys.argv[1])); open(sys.argv[2],'w').write(y['jobs']['staging']['steps'][0]['run'])" \
  "$repo/.github/workflows/deletion-retry.yml" "$work/step.sh"
secret=s3cr3t-s3cr3t-s3cr3t-s3cr3t-s3cr3t-0123
fails=0
check() { # mode probe expected-exit
  : > "$work/log"
  env -i PATH="$work/bin:/usr/bin:/bin" LOG="$work/log" MODE="$1" REAL_SECRET=$secret SECRET=$secret BYPASS=bp PROBE="$2" \
    URL='https://courtbook-staging-git-staging-web-paul-bc50.vercel.app/api/internal/deletions/retry' bash -e "$work/step.sh" > "$work/out" 2>&1
  rc=$?
  probe_real=$(head -n -1 "$work/log" | grep -c 'bearer=REAL'); [ "$rc" != 0 ] && probe_real=$(grep -c 'bearer=REAL' "$work/log")
  ok=true; [ "$rc" = "$3" ] || ok=false; [ "$probe_real" = 0 ] || ok=false
  echo "$($ok && echo ok || echo FAIL)  $1 probe=$2: exit $rc (want $3), probe requests with the real bearer: $probe_real"
  $ok || { fails=$((fails+1)); sed 's/^/      /' "$work/log" "$work/out"; }
}
check protected true 0
check public true 0
check broken true 1
check protected false 0
check public false 0
if [ "$fails" = 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL ($fails)"; exit 1; fi
