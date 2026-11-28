# F1 — staff moves check what the desk saw (draft, not applied)

> **0.5.0 candidate (27 Nov):** this is now migration **0099** — `supabase/migrations/0099_staff_moves_check_what_desk_saw.sql`, rollback `supabase/rollback/0099_down.sql`
> (number provisionally approved by Paul). The `sql/…draft.sql` paths below are the historical draft names.


Paul's decision of 26 Nov (operations audit F1): two staff members must not unknowingly overwrite each other's moves.
Optimistic concurrency, enforced **in the database, atomically inside the move**.

**Status:** draft. Not a numbered migration, not applied anywhere, **not part of the 0087–0093 staging sequence**.
Applying it needs its own migration number, the preflight, the postcheck and Paul's authorization.

## The defect (reproduced)

Two desks open Rana's booking on Padel 2, 18:00. Dina moves it to Padel 1. Maya, whose sheet still says Padel 2, moves
it to Padel 3. Today both calls succeed and the booking ends on Padel 3: Dina's move is silently lost.
`staff_moves/run.sh` shows it: without the draft, **both moves are applied in 26/26 races** (20 simultaneous).

## The change

| Piece | What it does |
| --- | --- |
| `sql/move_checks_what_desk_saw.draft.sql` | `move_booking_priced` gains three arguments: the court, start and end **the sheet was opened with**. After the booking row is locked (`select … for update`) they are compared with the row; any difference refuses with `booking_changed_elsewhere`. The comparison and the update are under the same lock, so nothing can change the row in between. Everything else is exactly 0091. |
| | The 0091 calls (`move_booking_priced` with 5 arguments, `move_booking`) now **refuse every move** (`move_needs_reload`). Nothing can move a booking without the comparison. They are kept, not dropped, so a page opened before the new website gets an answer ("Something went wrong. Refresh and try again.") instead of "function not found". |
| `sql/…down.draft.sql` | Both functions exactly as 0091; the new one dropped. Rows are never touched either way. |
| `supabase/live/staff_moves_preflight.sql` | Read-only. The live functions are exactly 0091's (md5), the new one does not exist, no update policy on bookings, nothing else calls the move functions. Any STOP: do not apply. |
| `supabase/live/staff_moves_postcheck.sql` | Read-only. The new function is the draft's (md5), security definer, fixed search path, callable by signed-in users only; the old calls only refuse; three move functions in all. |
| `src/app/staff/[slug]/DayCalendar.tsx` | The move sends what the sheet was opened with (not the 60-second refresh's copy). On `booking_changed_elsewhere` or `not_confirmed` the day is read again, the booking is read again, and the desk is told what changed. |

### Order of checks (unchanged except for the new line)

not signed in → not found → **forbidden** (staff of another club learn nothing) → not active (`not_confirmed`) → not a
court booking → **the comparison** → range, past, court, length, price, slot taken.

### What is compared, and why not a version number

Court, start and end: exactly what a move changes. If another desk moves the booking away and back again, it is where
this desk saw it, and the move applies (test M10); nothing this desk saw is out of date. A version column would need a
new column and trigger on `bookings` for no practical gain in the pilot.

## What the desk sees

| Case | Message | Sheet |
| --- | --- | --- |
| Moved elsewhere (court, time or length) | "This booking was changed on another screen: it is now on Padel 1, 18:00–19:00 (you opened it on Padel 2, 18:00–19:00). Your move was not saved. Check it before moving it again." (the day is named when it differs) | Stays open, showing the booking where it is now |
| Cancelled or marked no-show elsewhere | "This booking was cancelled on another screen, so your move was not saved." | Closes |
| Refused, and the booking cannot be read again | "This booking was changed on another screen, so your move was not saved. Check the calendar before moving it again." | Closes |
| No answer at all (lost connection) | Unchanged: R1 (never "saved", never "not saved") | Unchanged |

These refusals are certain (the database answered), so "not saved" is true. New key `booking_changed_elsewhere` in
`ERRORS` (`src/lib/types.ts`, copied to `mobile/shared/types.ts`; the app has no staff move).

## Rollout order (when authorized)

1. **Website first.** It calls the new function; while the database has only 0091's, PostgREST answers `PGRST202` and
   the page makes 0091's call, exactly as today. Once the database change is applied, 0091's call refuses every move,
   so this fallback can never skip the comparison.
2. **Then the database change**, as its own numbered migration: preflight → apply → postcheck.
3. Afterwards: remove the `PGRST202` fallback from `DayCalendar.tsx`; update the suites that still call 0091's
   signatures (`run.sh`, `staff_ops`, `fixes`, `races`, `m2`/`m86` deletion races, `audit`, `api/journey.mjs`,
   `staging_smoke.sh`, `staging_api.mjs`): today they run against 0001–0093, so they are left as they are.

**Checked against real PostgREST 12.2.3** (`supabase/tests/api/f1_rollout.mjs`, 13/13, with the website's own
`moveBooking`): before the change the fallback moves as today; with the change applied but PostgREST's schema cache
not yet reloaded, a stale view still cannot move the booking (the fallback's 0091 call refuses `move_needs_reload`),
and a fresh view is refused too until the cache reloads (a refusal, never an unchecked move; the desk refreshes and
tries again); after the reload, stale views are refused `booking_changed_elsewhere` with no fallback, old pages'
5- and 4-argument calls are refused, signed out and another club's desk are refused.

A page opened before step 1 and still open after step 2 gets "Something went wrong. Refresh and try again." on a move
(and the website reports it as unexpected). Refreshing fixes it.

## Tests

- `supabase/tests/staff_moves/run.sh` — scratch database:
  - controls before the draft: preflight passes, postcheck STOPS, `tests.sql` fails, race control sees both moves applied;
  - `tests.sql` 15/15: fresh view applied; out-of-date court, start or length refused; missing values refused; the 0091
    calls refused; another club's staff and the player forbidden whatever they send; no direct UPDATE; every other rule
    still refuses; move-away-and-back; cancel then move; rights;
  - `race.mjs`: 20 simultaneous rounds + 6 delayed (one desk's transaction still open), move against move and move
    against cancel; every round exactly one move applied, the other refused, the booking where the winner put it; the
    cancel always stands. Overlap is proved, not assumed: both actors wait on an advisory-lock barrier and are released
    together; each round records both transactions' times on the database clock and must show them overlapping; the
    delayed rounds must show the second actor waiting on the first's row lock (`pg_locks`). A round whose first try
    does not provably overlap is tried again on fresh courts (up to 3 tries; the count is printed). The behaviour
    checks run on every try;
  - idempotent; rollback restores 0091 exactly and the defect returns;
  - mutants, counted **only by behaviour**: a mutant is caught when `tests.sql` reports a named failing check, or the
    race harness reports a behavioural failure (two desks: exactly one applied; move versus cancel; I1). Not counted:
    `tests.sql` stopping on an error, the race harness crashing (no summary line), or failing only overlap proofs
    (inconclusive: re-run on an idle machine). The postcheck fingerprint (STOP/ok) is printed as an integrity check
    and never counted. 9/9 caught: no comparison; court only; an unlocked read compared (race only); check before the
    staff check; a missing seen court, start or end matches (three, one per line, review R101-1); old call still
    moves; anon allowed. Control X0 (a comment in the function body) must be reported not caught: its fingerprint
    changes (STOP), which shows a checksum mismatch alone proves nothing. The verdict parser self-tests at start.
- `supabase/tests/staff_moves/compat.sh` — the existing suites with the draft as a temporary 0094 and the test-only
  `legacy_adapter.sql` (0091's calls as wrappers that pass the current position): run.sh, staff_ops, fixes, races,
  deletion races. Shows the draft changes nothing but the comparison.
- `src/app/staff/[slug]/DayCalendar.moveConflict.test.tsx` — 9 tests; 7 fail on the current calendar.

## Not covered (tracked)

- Who moved or cancelled (audit history): a separate improvement, needs a migration.
- The incident guide's §4 ("the last change saved counts") changes once this is live.
