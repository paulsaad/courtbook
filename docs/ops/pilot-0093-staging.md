# Pilot 0093 (PR-8) — staging procedure (DRAFT, prepared 25 Nov; nothing run)

0093 makes `book_at_desk` and `hold_slot` refuse a closed account while holding the profile row and before locking any
court, and makes the older-app `request_account_deletion` take the profile row first (PR #55). It changes three
function definitions and nothing else: no table, no data, no grant.

## Preconditions (each its own approval)

1. **The deletion-retry trial is complete and its results are reviewed** (Paul, 25 Nov). Nothing below runs before that.
2. **Staging is at 0092.**
   - Staging has been at 0001–0086 since 24 Nov.
   - 0087–0092 go first: `docs/ops/release-candidate-staging.md` steps 4–7, with `rc87_preflight` and the gated apply
     from this branch.
   - The workflow refuses 0093 unless 0092 is recorded as applied.
3. **M12 stays off staging.**
   - Run the workflow from this branch (`staging-pilot-0093`). It has no M12 migration, workflow step or check.
   - The preflight and postcheck refuse if M12's `payment_attempts` table exists.
4. **Website: no change needed.** The refusal is the same `account_closed` the insert guards already gave; only the
   point where it is raised moved.

## Steps (GitHub Actions → "Staging database" → this branch)

| # | Action | Writes? | Expected |
| --- | --- | --- | --- |
| 0 | `check` | no | Pending lists `0093_closed_account_booking_lock_order.sql` only |
| 1 | `pilot_0093_preflight` | no | Every part-1 row ok, including the exact fingerprints of the three functions 0093 replaces and that 0092 is in |
| 2 | `apply`, migrations `0093`, confirm_ref `pwznauyioqykdwodwpvx` | **yes** | The workflow reruns the preflight, refuses 0093 alone without 0092 or with any other number, applies it in one transaction, records it, then runs the postcheck |
| 3 | `pilot_0093_postcheck` | no | Every row ok: 0093's exact text; the refusal after the profile lock and before `lock_courts`; the profile lock before the request insert; grants and security unchanged; no M12 |
| 4 | `pilot_0093_functional` | no (one transaction, rolled back) | 10 checks, 0 failed; 0 test accounts left |
| 5 | `smoke`, `cancel`, `api`, `m86_worker_check` | throwaway data, removed after | As before 0093 |

Step 4 covers, at the demo club, with one temporary court and two temporary accounts:
- a closed account is refused by `book_at_desk` and `hold_slot`;
- an open account books, and its retry is answered with the same booking;
- the older-app request still works, then refuses that person's next booking.

Players see the same answers as before 0093. The lock order itself is shown by the postcheck and the local race suite
(`supabase/tests/races/closed_account_booking.sh`).

## Stop conditions

- Any preflight row not ok: nothing is applied; report.
- Apply fails: one transaction, so nothing changed; report.
- Postcheck or functional check fails: report, then roll back (below) with Paul's approval.

## Rollback

Action `pilot_0093_rollback`, confirm_ref `pwznauyioqykdwodwpvx`. It is refused, and changes nothing:
- with a wrong confirm_ref;
- if 0093 is not recorded as applied;
- if any later migration is recorded.

Otherwise, in one transaction, it:
- puts back the three previous definitions byte for byte (`supabase/rollback/0093_down.sql`);
- forgets 0093 in `staging_meta.applied`.

The preflight then passes again. No data is involved either way.

## Rehearsed locally (25 Nov)

**`.github/tests/staging-pilot0093-steps.sh`** runs the workflow's own step scripts on a scratch 0001–0092 database:
14/14. It covers:
- the preflight passes;
- 0093 is refused without 0092;
- apply with preflight and postcheck;
- a second apply is refused;
- the preflight fails afterwards;
- the functional checks pass and leave nothing;
- the rollback refuses a wrong confirm_ref and a later migration, then restores the exact definitions;
- 0093 applies again.

**Checks that catch the wrong state:**
- The postcheck fails at 0092.
- The preflight fails at 0093.
- The functional checks give the same answers at 0092, as intended: they guard against changes players would see.

**`.github/tests/staging-rc87-steps.sh`:** PASS (0087–0092 gate unchanged).
