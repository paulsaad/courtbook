#!/usr/bin/env bash
# Checks the read-only coordinates audit against known good and bad points, on the local replica,
# inside a rolled-back transaction. Town points are approximate centres (good enough: the coast check
# is a heuristic with a 0.12° margin).
set -u
cd "$(dirname "$0")/../../.."
PSQL=${PSQL:-psql}
DB=courtbook_test
where=$($PSQL -At -d $DB -c "select current_database()||'@'||coalesce(host(inet_server_addr()),'local-socket')" 2>/dev/null)
case "$where" in courtbook_test@local-socket|courtbook_test@127.0.0.1|courtbook_test@::1) ;;
  *) echo "refusing: connected to '$where'"; exit 2;; esac
out=$(cat <<'SQL' | $PSQL -d $DB -X -q -At -F '|' 2>&1
begin;
-- 0088 refuses NEW half-filled points (not valid: existing rows are kept). The audit exists to find old ones, so this
-- rolled-back test recreates one by lifting the rule for its own transaction.
alter table clubs drop constraint if exists clubs_map_point_pair;
insert into clubs (name, slug, lat, lng, location_url, town_id) select v.name, v.slug, v.lat, v.lng, v.url, (select id from towns limit 1)
from (values
  ('Sea','a-sea',34.30,35.20,null), ('Copy','a-copy',34.2553,35.6586,null),
  ('Link only','a-link',null::numeric,null::numeric,'https://www.google.com/maps/place/X/@34.4367,35.8497,17z'),
  ('Far link','a-far',34.4367,35.8497,'https://maps.google.com/?q=33.8938,35.5018'),
  ('Near link','a-near',34.4371,35.8501,'https://www.google.com/maps/place/X/data=!3d34.4370!4d35.8500'),
  ('Half','a-half',34.1,null,null), ('North of the border','a-north',34.95,36.40,null), ('Damascus','a-damascus',33.5138,36.2765,null),
  ('Tyre','g-tyre',33.2705,35.1960,null), ('Ras Beirut','g-ras',33.9005,35.4700,null), ('Sidon','g-sidon',33.5571,35.3729,null),
  ('Jounieh','g-jounieh',33.9808,35.6178,null), ('Chekka','g-chekka',34.3297,35.7303,null), ('El Mina','g-mina',34.4510,35.8122,null),
  ('Akkar','g-akkar',34.5960,35.9660,null), ('Baalbek','g-baalbek',34.0047,36.2110,null), ('Naqoura','g-naqoura',33.1181,35.1397,null)
) v(name, slug, lat, lng, url);
\i supabase/tests/favourites/club_coordinates_audit.sql
rollback;
SQL
)
status=0
expect() { # slug, expected issues ("" = not listed)
  local got; got=$(echo "$out" | awk -F'|' -v s="$1" '$1==s {print $6}')
  if [ "$got" = "$2" ]; then echo "ok   $1: ${2:-no issue}"; else echo "FAIL $1: got '${got}', expected '$2'"; status=1; fi
}
expect a-sea "probably_in_sea"
expect a-copy "shared_point"
expect batroun "shared_point"
expect a-link "map_link_only, missing"
expect a-far "map_link_differs"
expect a-near ""
expect a-half "half"
expect a-north "outside_lebanon"
# Known blind spot, recorded rather than hidden: the eastern and southern borders are not straight
# lines, so a point in Syria near Damascus (33.51N 36.29E) passes the extent check. Catching that
# needs town coordinates (the club should be within ~15 km of its town) — see the assessment.
expect a-damascus ""
for g in g-tyre g-ras g-sidon g-jounieh g-chekka g-mina g-akkar g-baalbek g-naqoura; do expect $g ""; done
[ $status = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
exit $status
