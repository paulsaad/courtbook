# Table-privilege hardening — DRAFT (not applied, not deployed)

Approved for preparation by Paul (26 Nov). Unnumbered: `sql/table_privileges.draft.sql`, rollback
`sql/table_privileges.down.draft.sql`. **Separate from the approved 0087–0093 staging sequence:** it would follow 0093
with its own number, preflight, postcheck and Paul's go.

## The problem (measured on 0001–0093 locally; the same grants seen on staging in the read-only fingerprint of 26 Nov)

Supabase gives every new table ALL privileges to `anon` and `authenticated`, and row-level security then decides which
rows. That leaves players (`authenticated`) holding privileges the app never uses:

- **TRUNCATE, TRIGGER and REFERENCES** on 29 tables and 2 views. TRUNCATE ignores row-level security.
  - A player with a direct SQL connection could empty any of the 18 tables that no foreign key references. Among them:
    `payments`, `match_players`, `club_staff`, `notifications` and `account_deletions` (proved in the test, D05 and D06).
  - `bookings` itself is protected by foreign keys.
  - **Not reachable today:** the data API has no TRUNCATE, and players have no direct SQL connection.
  - Visitors (`anon`) hold none of these (the audit's CAT4b).
- **35 INSERT, UPDATE or DELETE privileges that no policy lets a player use**, on 15 tables.
  - Row-level security refuses them or matches nothing.
  - The app writes these tables only through database functions, which run as their owner.

## What the draft does

1. Revokes TRUNCATE, TRIGGER and REFERENCES from `anon` and `authenticated` on every table and view in `public`.
2. Stops new tables (created by migrations as `postgres`) from receiving them by default. New tables still receive
   SELECT, INSERT, UPDATE and DELETE by default.
3. Revokes the 35 unusable write privileges, listed table by table in the SQL.

## Unchanged

- Every privilege a policy makes usable. These cover the app's direct writes:
  - club, court and price set-up;
  - removing a block;
  - coach listings and availability;
  - chat messages;
  - editing one's own profile;
  - reading notifications;
  - the admin's club and geography edits.
- SELECT everywhere.
- Column-level grants: the readable columns of `club_media` and `towns`, and `notifications.read_at`. (A table-level
  REVOKE of a privilege also removes column grants of the same privilege, so none of those types is revoked on those
  tables. The test V6 and mutation M4 cover this.)
- The server key (`service_role`). H1 on `account_deletions` is a separate decision.
- Function EXECUTE grants.

**Only visible behaviour change:** a direct attempt at something no policy allows now fails with "permission denied"
instead of matching nothing. The app makes no such attempt.

## Evidence

`PSQL="sudo -u postgres psql" bash supabase/tests/privileges/table_privileges.sh` builds two databases from the same
migrations and seed: one without the draft, one with it. **47/47 checks pass.**

- **V1–V8, invariants.**
  - No TRUNCATE, TRIGGER or REFERENCES remain, and every remaining write privilege is usable through a policy.
  - Controls: without the draft there are 93 such grants and 35 unusable writes.
  - Visitors, the server key, SELECT and column grants are unchanged.
  - New tables receive no TRUNCATE.
  - The rollback restores exactly the previous rights.
- **W01–W26: the app's own writes, as a player, desk staff, a coach and an admin.**
  - They mirror the code: ProfileForm, MatchChat, notifications, ClubSettings, ClubReadiness, NewClubForm,
    CoachDashboard and DayCalendar, plus functions such as `set_player_level`, `leave_match`, `hide_match`,
    `staff_block`, `mark_notifications_read`, `delete_match_message` and `set_match_status` (W27).
  - **Every result is identical with and without the draft.**
- **D01–D07, direct attempts that no policy allows.** These are the only changes.
  - Before the draft: nothing, or a row-security error, and for D05/D06 a successful TRUNCATE.
  - After: permission denied.

**Mutation checks** (each must make the test fail):

| Mutation | Fails |
| --- | --- |
| A revoke left out | V2, D01 |
| The TRUNCATE part left out | V1, D05, D06 |
| One revoke too many (staff can no longer add a court) | W10 |
| `notifications` UPDATE revoked (kills the `read_at` column grant) | V6, W05 |
| A rollback line missing, or the views missing from the rollback | V8 |

**Full local matrix** on the pilot line (`int/pilot-26nov` + 0093), with the draft copied in as migration 0094 in a
throwaway local tree:
- **50 of 53 suites passed at first.** These include the API journey and security suites through a real local API (player and
  staff paths), booking races, staff operations, deletion races, the deletion pipeline end to end, and the website and
  app suites.
- **The other 3 failed because 4 tests assert the old mechanism, not the property.** All 3 pass without the draft:

| Test | What it asserted | Now (same property) |
| --- | --- | --- |
| `blocks.sh` | Builds every migration except 0076/0077, then rehearses their rollout (stage A: the old website inserting blocks directly) | Leaves the privilege migration out of that build: it follows 0093 and assumes 0077's policies |
| `fixes/checks.sql` S1d | Players still *hold* UPDATE on `matches` ("cancel path unchanged") | Players can cancel through `set_match_status` (no policy has let them UPDATE `matches` directly since 0072) |
| `audit/run_audit.sh` PRIV4, PRIV5 | Updating one's own hold or payment changes 0 rows | Refused either way: 0 rows, or no privilege (the bare error aborted the audit's catalog block) |
| `m86/close_tests.sql` F3 | A closed account's level change fails with `account_closed` | `account_closed` or permission denied |

With these adaptations all four suites pass **both with and without** the draft: blocks OK; fixes 95 ok; audit
62 ok + 1 known finding; deletion86 102 + 126 ok.

**Ordering rule:** the draft is measured against the policies after 0093. It must be applied after them, never
before 0077.

## Before it could be scheduled

- Independent review.
- A read-only staging preflight: the same measurement on staging, expecting the same 93 + 35. Any difference stops the step.
- A postcheck: V1, V2, V3, V5 and V6 on staging.
- Its own migration number after 0093, and Paul's go.
