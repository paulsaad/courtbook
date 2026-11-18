# M3 — 10. Implementation status (18 Nov 2026)

Branch **`m3-dev`** = `m3-foundation` (`bb811bd`) + `main` (`661acf2`: M2, accessibility, release
fixes 0068–0071) + the work below. Not merged into `main`. Nothing applied to staging or live; no
build, update or deployment.

## 10.1 Spec coverage (product spec §Matches / Find a game, against what exists)

| Area | Database | App data layer (`mobile/lib`) | App screens |
| --- | --- | --- | --- |
| Discovery (board, club games) | Done: `open_matches`, `match_board` | Done: `useOpenGames`, `useClubGames`, filters, freshness, signed-out gating | Waiting for Stitch approval |
| Game detail | **0067 `match_detail`** — migration file on `m3-dev`, tested; not on staging or live | Done: `useGame` (off until 0067 is on the server: `MATCH_DETAIL_AVAILABLE`), `gameState`, wording | Waiting for Stitch approval |
| Join / ask, withdraw, leave | Exist; `leave_match` has defect S4 (declined player can ask again) → M3-H | **New:** `gameActions.ts` (off: `GAME_WRITES_AVAILABLE`) | Stage 3, after M3-H |
| Approval (accept / decline), edit, private / reopen / cancel | Exist; S11, S15, S19 gaps → M3-H | **New:** in `gameActions.ts` (off) | Stage 3 |
| Remove a player, court-cancelled resolution | **Missing** (`remove_player`, `resolve_court`) → M3-H | — | Stage 3 |
| Post a game | Exists; S10 (no club / no horizon) → M3-H | — | Stage 3 |
| Messaging (chat) | Exists with S2, S9 (sender timestamp, insert rules) → M3-H; report / block missing → M3-S | — | Stage 4 |
| In-app notifications | Exist; S5 fixed by release fix 0069 (staging) | — | Stage 5 (Activity) |
| Email for app actions | Web-only today (cookie route); app actions send none (S16) → M3-D | — | — |
| Push | Missing → M3-D + `deliver` function | — | Stage 6 (native build) |

## 10.2 Done on `m3-dev` (this round)

1. `main` merged into the foundation without conflicts (`1a75ee9`).
2. **Migration 0067** promoted unchanged from the validated draft (`09c0ed9`). The 0067 suite now runs
   against the file on a 0001–0071 replica. The release-fixes suite's F6 applies 0067 after the four
   release scripts, on a copy, so F7's rollback check is unaffected.
3. M3 docs renumbered: hardening / safety / delivery are **M3-H / M3-S / M3-D**, numbered when
   approved; S1 and S5 are marked as delivered by release fix 0069.
4. **Game actions** (`mobile/lib/gameActions.ts`, `cda9415`), switched off. Each action calls one
   existing function. Only one call per action runs at a time, a failed call is not retried
   automatically, and the game is re-read when the outcome is uncertain. 20 unit tests.
5. **Contract check** `supabase/tests/m3/row_types.sh` compares two things with the functions on the
   replica: the app's row types (columns and order) and the argument names of the write calls. A
   deliberate mismatch made each part fail.

## 10.3 Checks (local replica / CI tooling; nothing remote)

| Check | Result |
| --- | --- |
| SQL suite `supabase/tests/run.sh` (0001–0071 + 0067) | 381 / 381 |
| 0067 suite `supabase/tests/m3/match_detail_0067.sh` | 200 / 200; 9 / 9 mutants detected; replica unchanged |
| Release-fixes suite `supabase/tests/fixes/run_fixes.sh` | 95 / 95 |
| Contract check `row_types.sh` | 4 row types + 6 write calls match; mutations detected |
| `docs/m3/repro/m3_findings.sh` (stage-2 baseline) | F3, F9 not reproduced (release fix 0069); others reproduced as expected. F7 still reproduces: it tests the web path, which the M3-H web change fixes |
| Mobile: tsc, jest, shared copies, production bundle | ok; 36 suites, 361 tests; copies match; iOS and Android bundles ok |

## 10.4 Next, in order

| # | Step | Needs |
| --- | --- | --- |
| 1 | Stitch review of board and detail (pack 2, project doc) | Paul runs it; review; Paul approves |
| 2 | Pre-0067 read-only checks on staging and live: `matches_closed_reason_check` definition; `authenticated` statement timeout (chat cursor) | approval to run read-only checks |
| 3 | 0067 to staging (`apply` naming `0067`; staging `check` will list it "out of order", as designed) + API G1 | **Paul's approval** |
| 4 | Stage 1 screens: board, game card, detail (read-only), Club → Games, Bookings → Games tappable; switch `MATCH_DETAIL_AVAILABLE` on | steps 1 and 3 |
| 5 | M3-H hardening: SQL + tests (§AP, T-CL) + web changes (P4: two strings, game page on `match_detail`) | go-ahead to write it; staging regression before any live release (web deploys on merge to `main`) |
| 6 | Stage 3 screens; switch `GAME_WRITES_AVAILABLE` on; add `remove_player`, `resolve_court` | M3-H on staging |

## 10.5 Risks

- **Web game page 404s after a game starts** (S6/F7). The fix is the M3-H web change, so it stays
  open until then.
- **Actions made in the app send no email** (S16) until M3-D. Before then, stage 3 players get
  in-app notices only. This is a product decision; see 10.6.
- **0067 is applied out of order.** This is designed and tested: the schema is the same in either
  order. The workflow applies only the migrations named in the request, so 0067 cannot be applied
  by accident.
- **M3-H changes web behaviour in production.** It changes the reason a game with a cancelled court
  is closed, adds new refusals and the two web strings. It needs the staging regression listed in
  `02-safety-review.md` §2.5 before it reaches `main`.
- **The Stitch review is the critical path for every screen.** The data layer is ahead of the
  designs.

## 10.6 Decisions needed from Paul

1. Run Stitch pack 2 (board and detail), then approve the reviewed designs.
2. Approve the two read-only pre-checks, then 0067 on staging (and later, separately, on live).
3. Go-ahead to write M3-H (hardening SQL, tests and the two P4 web strings plus the web game page on
   `match_detail`). Nothing will be applied without a further approval.
4. Email for actions made in the app before M3-D: (a) accept in-app notices only for stage 3, or
   (b) bring forward request authentication on the email route (G1, parked on `payments-g1`).
   The plan recommends the database-driven dispatcher (M3-D) and does not settle the interim.
