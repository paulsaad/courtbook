# Calendar blocks — longer blocks, start/end selectors, "Not saved" highlight (0076/0077)

Approved 21 Nov 2026 (Paul, after ChatGPT review). Branch `blocks-0076`. Nothing applied to any database.

## What changes for the desk

- **Block a court for any length** inside opening hours: Start and End selectors on the club's grid. End runs to
  closing time or to the next booking, payment hold or block on that court. A slot that has ended is not offered
  as a start; the slot running now is.
- **"Not saved" highlight** on the grid for the open form's interval — blocks and desk bookings, day and week
  views: light amber, dashed outline, "Not saved · 10:00–16:00". It follows every change of start, end or length,
  goes when the panel closes or another slot is chosen, and is replaced only by the hatched block or the booking
  that the database returns after saving.
- A changed start, end or length counts as unsaved, like typed text: switching slot, closing, changing day or
  following a link asks "Discard the details you have entered?".
- Conflicts: one attempt, a clear message, the form and highlight stay. "That range is already blocked." /
  "There is a booking in that range. Cancel or move it first." / "That time has passed." / "Outside opening hours."
- Unchanged: booking lengths (club minimum to maximum), Close courts, moves, cancellations, no-shows.

## Database (`supabase/migrations/0076_staff_block.sql`, `0077_blocks_through_functions.sql`)

| Rule | Where |
| --- | --- |
| Caller is staff of the club (or CourtBook admin) | `staff_block`: `is_staff_of(club)` |
| Court is an active court of that club | `assert_valid_block` |
| Whole slots, on the club grid, inside opening hours, one day — in the club's time zone | `assert_valid_court_slot` (the booking check, without booking min/max) |
| Not wholly in the past (started-and-running allowed) | `assert_valid_block`: `end > now()` |
| No overlap with confirmed bookings, unexpired holds, other blocks | unchanged: trigger `reject_block_over_booking` (0013), constraint `no_overlapping_blocks` |
| Court lock (same as every booking path) | `staff_block` locks the court row first; the trigger locks it too |

`staff_block` runs with owner rights, so the trigger's expired-hold sweep works (before, as the desk user, it
updated nothing and an expired hold wrongly refused the block).

**Rollout safety (older open pages).** 0076 is additive: the current website keeps inserting directly, and from
0076 on such direct inserts/updates by a signed-in user follow the same rules (trigger
`blocks_direct_write_rules`, keyed on `current_user` being a client role; `staff_block` and `close_club` run as the
owner and are not affected). 0077 removes the staff write policy (delete and read stay) and the update right; an
older page's direct insert gets "CourtBook has been updated. Reload the page, then block the time again.", and
row-level security refuses it even without that trigger. Existing blocks are never touched.

Close courts (`close_club`) is unchanged by design, including that it accepts any range it is sent.

## Order

1. Staging: `blocks_0076_preflight` → apply `0076` → `blocks_0076_postcheck` → `blocks_functional`.
2. Website on staging (m3-dev) → Paul's check on desktop and phone.
3. Staging: `blocks_0077_preflight` → apply `0077` → `blocks_0077_postcheck` → `blocks_functional`.
4. Live, each after its own approval: `0076_preflight.sql` → `0076_apply.sql` → `0076_postcheck.sql`; production
   website; desk reloads its pages; `0077_preflight.sql` → `0077_apply.sql` → `0077_postcheck.sql`.

Rollback: `0077_rollback.sql` first, then the website, then `0076_rollback.sql`. Each restores the previous schema
exactly (checked) and changes no block.

## Tests

- `supabase/tests/blocks.sh` — 83 checks: permissions, court ownership, grid/hours in two time zones, past,
  overlap with bookings, holds and blocks, expired-hold sweep, six same-moment races, old-page behaviour at each
  stage, Close courts, delete, rights, re-application, rollbacks, saved blocks byte-identical throughout.
- `supabase/tests/live_blocks.sh` — 28 checks of the deployment files on copies of an origin/main build.
- `supabase/tests/run.sh` — the full suite (381) with 0076/0077 applied.
- Website: `durations.test.ts`, `DayCalendar.test.tsx` (selectors, highlight, conflict, unsaved choices, week
  view, today's ended slots).
