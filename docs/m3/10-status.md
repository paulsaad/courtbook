# M3 — 10. Implementation status (updated 20 Nov 2026, round 4)

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

## 10.7 Round 2 (19 Nov) — hardening, game functions, 0067 pack, screen structure

| Item | Where | State |
| --- | --- | --- |
| M3-H hardening (S2, S4, S8–S12, S14–S15, S18–S19; GR-6, GR-8, GR-9) incl. `remove_player`, `resolve_court` | `docs/m3/sql/m3h_game_hardening.draft.sql` | draft, number assigned at approval; applied nowhere |
| §AP tests | `supabase/tests/m3/hardening.sh` | 60/60, 15/15 mutants detected; whole SQL suite 381/381 with the draft (`EXTRA_MIGRATIONS`) |
| Web adjustments (P4) | board badge, game-page hints, refusal copy; `/matches/[id]` on `match_detail` with fallback | on `m3-dev` only |
| App actions incl. remove / resolve court | `mobile/lib/gameActions.ts` | switched off (`GAME_WRITES_AVAILABLE = false`) |
| 0067 staging/live pack | `supabase/live/0067_{preflight,apply,postcheck,rollback}.sql`; workflow actions `m3_0067_preflight` / `m3_0067_postcheck` | tested locally 15/15; not run on staging |
| Screen structure | `mobile/lib/gameScreens.ts` | section order and content from §4.3–4.4; no routes or layout until Stitch approval |

Choices made where the spec left a detail open (all reversible, listed for review):
- S12 "open games" counts every game not cancelled and not started (private and full included).
- GR-8 time limits apply to admins too (status changes after start refused for everyone).
- A booking cancelled after its game was played only removes the link (no state change, no notices).
- `remove_player` on a pending request answers `not_accepted` (requests are declined, not removed).
- Cancelling an already-cancelled game is a no-op (no repeat notices).
- New notice texts (stored bodies, web wording "match"/"organizer"): `match_full_waiting`,
  `player_removed`, `court_resolved`, new `booking_unlinked` texts.

Pre-existing, not caused by M3: SQL suite check 95a fails when run shortly after midnight UTC
(reproduced on `main` at 00:14 UTC, 19 Nov; passed at 23:00 UTC the evening before).

## 10.8 Round 3 (19 Nov) — review corrections, 0067 on staging

- **0067 on staging (Paul's approval, staging only):** preflight run 44485229713 part 1 9/9 true
  (statement timeout for signed-in users: 8s); apply run 44485327343 "applied 1 migration(s)", RLS
  policies 49, demo club at the desk; postcheck run 44485458241 8/8 true. Not on live.
- **M3-H draft corrections (still a draft, applied nowhere):** per-user transaction locks make the
  three limits hold under simultaneous requests — 10 live games per organiser (`post_match`), 20
  waiting requests per player across games (`join_match`), 30 messages per sender per game per
  10 minutes (chat insert guard; rows of one multi-row insert count too). `push_text(notification)`
  gives the only text a push may carry, built from the kind and the game (S7).
- **Tests:** `hardening.sh` 65/65, 17/17 mutants; `hardening_races.sh` 3 two-session races hold the
  limit, and the same races exceed it with the locks removed (control); SQL suite 381/381 with and
  without the draft.
- **Decision recorded (Paul, 19 Nov):** the first game functionality uses in-app notices only; push
  and email remain separate delivery milestones (M3-D).

## 10.9 Round 4 (20 Nov) — the game screens

Built from the approved Stitch exports (14 board; 26–30 detail states A–E), on `m3-dev`:

| Screen / flow | Data (all under the player's own session) | State |
| --- | --- | --- |
| Find a game (`app/games`) — sport, Today / This week / Any time, area sheet, My level, cards, all load states | `open_matches`, `my_levels`, `areas` | done |
| Game (`app/game/[id]`) — one screen for A–E and playing / played / private / full / cancelled | `match_detail` (0067), `match_participants` (organiser and accepted players only) | done, read-only |
| Club → Games tab; Bookings → Games rows open the game; Home entry; `courtbook://match/<id>` | `match_board`, `my_agenda` | done |
| Activity (Home bell, Profile row, `courtbook://activity`) | own `notifications`, newest 50 | done, read-only (nothing marked read) |
| Join / ask, withdraw, leave, accept / decline, remove, manage (private / reopen / cancel), court choices (link booking / go ahead / cancel) | 0072 functions | wired, **off** (`GAME_WRITES_AVAILABLE`, `SCREEN_FEATURES.writes`); no control drawn while off |
| M3-H | `supabase/migrations/0072_game_hardening.sql` | numbered candidate, applied nowhere |

Where the exports were not followed (they show things the spec or the data do not have): no Share
or Post button, no avatars or initials, no "Format: Doubles", no decimal levels ("5.0"), no "asked
2 h ago" (participants carry no request time), no "cancelled by venue" (who cancelled is not
known), no Chat button (chat is stage 4). A cancelled booking shows "No court booked through
CourtBook", not a struck-out court.

Not verified on a device: layouts are built to wrap (Dynamic Type up to 1.6×, time capped at 1.2×
like the ticket) and pass the unit tests, but have not been seen on a phone or emulator.

## 10.10 Round 5 (20 Nov) — screenshot pass, mark-read, 0072 package

- **Activity marks notices read** (`mark_notifications_read`, own rows only, existing grant). Rows
  unread on opening stay bold for that visit; opening a game marks that game's notices. Deletion: later.
- **Emulator screenshot pass** (`suite=m3-screens`): board and detail states at 412dp ×1.0 (all
  states) and 360dp ×1.0 / ×1.6 / ×2.0 (A–E), from a test-build-only route with sample data
  (`EXPO_PUBLIC_E2E=1`; the route redirects home in any other build). Fixes from it: the Game screen
  remounts per game (a reused route kept the previous scroll position); the details row shows the
  level range once; Segmented labels and the action bar are capped at ×1.3 so they stay one line /
  one bar at ×2.0.
- **0072 staging package** (`supabase/live/0072_*`, applied nowhere): read-only preflight, guarded
  apply (stops unless the eight functions are byte-identical to 0001–0071), postcheck (13 function
  hashes, trigger, grants), rollback (refuses while any game depends on the new court states).
  `live_0072.sh` 15/15. Test with the `m3-dev` website: `main`'s website shows a court-cancelled game
  as "Private" and new refusals as raw codes.
- Game writes stay off until 0072 is approved and applied to staging.
- Screenshot run 44657558112 (`ffa0ae0`): all configurations passed except state E at 360dp ×2.0,
  where the flow's own check expected the game summary on the first screen; the screen was correct
  (organiser strip and court banner first, as in Stitch 30). The flow now waits for the screen.
- Open, not fixed: at ×2.0 on Android, line spacing grows more than the letters (fixed `lineHeight`
  values seem to ignore the size cap). Affects every screen; one change in the shared `Text`, to be
  proposed separately.
