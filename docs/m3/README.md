# M3 — Find a Game: preparation package

Branch `m3-prep` (from `cec5a95`, the frozen M2 head). **Documentation, test specifications and
local-replica scripts only.** Revision 2, 16 Nov 2026, after Paul's review with ChatGPT.

> **Status: accepted by Paul, 16 Nov 2026 — preserved for implementation.** P1–P4 accepted
> (`09-decisions.md` §9.2); safeguards S-A (field review, done on the draft) and S-B (delivery tests
> before code) added (§9.3). Implementation starts after M2 closes and Paul authorises it, in the
> stages of `07-roadmap.md`. Migration 0067 still needs Paul's separate approval for staging and for
> live; board and game-detail screens wait for the Stitch review; no live database change and no
> production push without explicit approval.

| File | Contents |
| --- | --- |
| `01-audit.md` | What exists (database, web, native), what is partial or missing, what is reusable |
| `02-safety-review.md` | Findings S1–S19; controls; migration plan 0067–0070; checks and changes before any migration |
| `03-journeys.md` | **Game rules GR-1…GR-12** (single source) and ten native journeys with messages |
| `04-ux-spec.md` | Screens in Court Lines, message for every server code, push copy, Stitch candidates |
| `05-architecture.md` | Data layer, write safety, chat cursor (verified), delivery reliability, moderation |
| `06-test-plan.md` | SQL, staging, delivery, unit, E2E, accessibility, device tests; exit criteria |
| `07-roadmap.md` | Stages, Stitch timing, first slice with exact acceptance, implementation order |
| `08-traceability.md` | Requirements and review points → rules → design → tests → stage |
| `09-decisions.md` | Settled defaults; four product decisions for Paul (P1–P4) |
| `sql/0067_match_detail.draft.sql` | Proposed first migration (draft, not applied anywhere) |
| `repro/m3_findings.sh` | Reproductions F1–F10, controls C1–C2 |
| `repro/match_detail_matrix.sh` | Authorisation matrix for the draft, in a rolled-back transaction |
| `repro/chat_cursor.sh` | Chat cursor hazards (delayed commit, deletion) |

All three scripts refuse to run anywhere but the local replica `courtbook_test`:

```
service postgresql start
PSQL="sudo -u postgres psql" bash supabase/tests/run.sh          # builds courtbook_test
PSQL="sudo -u postgres psql" bash docs/m3/repro/m3_findings.sh
PSQL="sudo -u postgres psql" bash docs/m3/repro/match_detail_matrix.sh
PSQL="sudo -u postgres psql" bash docs/m3/repro/chat_cursor.sh
```

Results on 16 Nov 2026: F1–F10 reproduced, C1–C2 control OK; `MATRIX PASS` and `FIELDS PASS` (each
fails under its mutation); chat cursor hazards confirmed and the planned client rule recovers both.

## Readiness report (revision 2)

**Review points addressed**

| # | Point | Outcome |
| --- | --- | --- |
| 1 | Cancelled court booking | GR-9: game, players and chat kept; `closed`/`no_court` pauses joins and approvals using the existing `join_match` / `decide_join` checks; everyone told; organiser links another of their bookings, goes ahead without a CourtBook court (P1), or cancels; no automatic re-booking. Also found S18: a no-show mark is treated as a cancellation today |
| 2 | `match_detail` first | Draft written and validated (8 roles × 7 states, mutation-checked); migration 0067 is now step 1 of stage 1; the detail screen never uses `match_board` |
| 3 | Delivery | Queue in `notifications`, drained by a scheduled function; leases + `skip locked`; retries with backoff; give-up after 6 attempts / 24 h; dead tokens from tickets and receipts; staging/live separated by project, secrets, variant check and a disabled switch. At-least-once, not exactly-once — stated |
| 4 | Chat polling | Strict cursor shown to lose delayed commits; fix = 10 s overlap + de-dup + 60 s full reload + reload on focus; 10 s rests on the 8 s statement timeout (to be confirmed read-only on staging/live) |
| 5 | Moderation | Paul as moderator (P2), email + web admin page, daily check on working days, action ladder, serious-incident handling; no response time promised to players |
| 6 | Decisions and consistency | Twelve defaults settled; four product decisions (P1–P4); one rule table used by UX, DB and tests; every stage-1 acceptance item mapped to the function that makes it achievable |
| 7 | Readiness | First slice, Stitch screens, implementation order, test cases, pre-migration checks — `07-roadmap.md`, `02-safety-review.md` §2.5 |

**Remaining blockers before implementation**

1. M2 closure: Galaxy A17 test (Wed 18 Nov), final checks, merge.
2. Paul's authorisation of M3 (P1–P4 accepted 16 Nov).
3. Stitch approval of board and detail (blocks stage 1 screens only; migration 0067 and the data
   layer can proceed).
4. Paul's go-ahead to apply 0067 to staging.

## What was changed, and what was not

**Changed:** files under `docs/m3/` on `m3-prep` only. On the local throwaway replica: test rows from
the scripts; the `match_detail` draft existed only inside rolled-back transactions (verified gone).

**Not changed:** application code (web or mobile), `supabase/migrations/`, any staging or live
database, deployments, EAS builds or updates, payment code, Club Info / Sentry / booking-recovery
work, `mobile-m2-native` (still `cec5a95`), `main`, `payments-g1`. No test in `06-test-plan.md` has
been written or run.
