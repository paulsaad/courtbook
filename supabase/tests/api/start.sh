#!/usr/bin/env bash
# A local copy of Supabase's database API for acceptance tests: PostgREST (the same server Supabase runs) on a scratch
# copy of the local replica, behind a tiny proxy at http://127.0.0.1:54329 that serves it at /rest/v1 like Supabase.
# The website's and the app's own supabase-js calls (queries, embeds, RPCs, RLS) then run unchanged against it.
# LOCAL ONLY. No Auth server: tests sign their own JWTs with the scratch secret (same claims as Supabase Auth).
#
#   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh            # build courtbook_test
#   PSQL="sudo -u postgres psql" bash supabase/tests/api/start.sh       # → API up; prints the env to use
#   ...tests...
#   bash supabase/tests/api/stop.sh
set -eu
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
SRC=courtbook_test; DB=courtbook_api
BIN=${PGRST_BIN:-/tmp/pgrst/postgrest}
if [ ! -x "$BIN" ]; then
  mkdir -p "$(dirname "$BIN")"
  curl -sSL -o /tmp/pgrst/pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
  tar xJf /tmp/pgrst/pgrst.tar.xz -C "$(dirname "$BIN")"
fi
where=$($PSQL -At -d $SRC -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;; *) echo "refusing: $where"; exit 2;; esac
bash supabase/tests/api/stop.sh >/dev/null 2>&1 || true
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB template $SRC" >/dev/null
SECRET=local-acceptance-secret-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
PASS=api-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')
$PSQL -q -d $DB -v ON_ERROR_STOP=1 <<SQL >/dev/null
-- Supabase's own definitions (the replica's shim reads only the older claim setting)
create or replace function auth.uid() returns uuid language sql stable as \$\$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$;
do \$\$ begin create role authenticator login noinherit; exception when duplicate_object then null; end \$\$;
alter role authenticator with login noinherit password '$PASS';
grant anon, authenticated, service_role to authenticator;
SQL
mkdir -p /tmp/courtbook-api
cat > /tmp/courtbook-api/pgrst.conf <<CONF
db-uri = "postgres://authenticator:$PASS@127.0.0.1:5432/$DB"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-host = "127.0.0.1"
server-port = 3011
db-pool = 20
CONF
nohup "$BIN" /tmp/courtbook-api/pgrst.conf > /tmp/courtbook-api/pgrst.log 2>&1 &
echo $! > /tmp/courtbook-api/pgrst.pid
nohup node supabase/tests/api/proxy.mjs > /tmp/courtbook-api/proxy.log 2>&1 &
echo $! > /tmp/courtbook-api/proxy.pid
for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:54329/rest/v1/ && break; sleep 0.5; done
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54329/rest/v1/clubs?select=id\&limit=1)
echo "API_URL=http://127.0.0.1:54329"
echo "API_JWT_SECRET=$SECRET"
echo "API_DB=$DB"
echo "API_CHECK=$code"
printf '%s\n' "API_URL=http://127.0.0.1:54329" "API_JWT_SECRET=$SECRET" "API_DB=$DB" > /tmp/courtbook-api/env
