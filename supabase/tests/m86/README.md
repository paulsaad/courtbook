# 0086 tests (account deletion: one confirmation, immediate closure, automatic processing)

All on the **local replica only** (`courtbook_test`, built by `supabase/tests/run.sh`). Never staging or production.
Start Postgres with `sudo pg_ctlcluster 16 main start`; then run with `PSQL="sudo -u postgres psql"`.

| Runner | What | Result on 23 Nov |
| --- | --- | --- |
| `bash supabase/tests/run.sh` | All migrations, including 0086, applied twice; the general suite | 381 checks, 0 failures |
| `bash supabase/tests/m86/deletion86.sh` | `ported_0079_tests.sql` (0079's suite on 0086) and `close_tests.sql` (new), then 28 mutants of 0086 | 102/102 and 99/99; all 28 mutants detected |
| `bash supabase/tests/m86/races86.sh` | Two real sessions at once: double close, booking during close, close during booking, two claims, two data steps, joining a game being cancelled | 15/15 |
| `bash supabase/tests/m86/ported_deletion_races.sh` | 0079's race suite on 0086 (RD5 restated: a closed account's own cancel is refused) | 18/18 |
| `PG_MODULE=… bash supabase/tests/m86/pipeline_e2e.sh` | The website's TypeScript pipeline against the real functions: each step failing, the process dying after each step, the late-booking race, two runs at once, held/release, staff refused, alerts. Then 6 pipeline mutants | 48/48; 4 mutants detected, 2 expected survivors (explained in the script) |

## Ported suites (how 0079's tests carry over)

0086 replaces 0079's request-and-cancel model:
- one confirmation, no undo (D1);
- `requested` became `closing`;
- `account_deletion_requested` became `account_closed`;
- held accounts get a cancel-only data step.

0079's tests are not edited by hand. They are **generated** by:
- `port_0079_suite.py` → `ported_0079_tests.sql`: 17 named replacements, each checked to apply exactly the expected
  number of times. The data-step checks are unchanged.
- `port_0079_races.py` → `ported_deletion_races.sh`: 2 edits (the database name; RD5).

Re-run both scripts after changing 0079's originals. The originals still pass on a replica without 0086:
`supabase/tests/m2/deletion.sh` and `deletion_races.sh`, checked 23 Nov. On a replica with 0086 they cannot pass,
because `deletion.sh` re-applies the 0079 file over 0086.

## Not covered here

- The real Supabase Auth API. Ban and delete are simulated on the replica's `auth.users`. The ban duration and the
  "user not found" answers need checking on staging.
- PostgREST's error shapes. The adapter mirrors `{message, code}`.
- Staging data. Nothing here has run against staging.
