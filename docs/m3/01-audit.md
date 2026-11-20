# M3 — 1. Audit of the existing system

Baseline: branch `mobile-m2-native` at `cec5a95` (M2, frozen). Database: the 66 migrations in
`supabase/migrations/` (the local replica `courtbook_test` is built from them; live and staging were
not read or changed). "Native" means the Expo app in `mobile/`.

Legend: **Done** = works end to end and is covered by the SQL suite or web tests ·
**Partial** = exists with a gap named in the row · **Missing** = nothing exists.

## 1.1 Feature status

| # | Capability | Database | Web | Native | Notes |
| --- | --- | --- | --- | --- | --- |
| A1 | Find open games (board) | Done — `open_matches(sport, fit, from, to, governorate, district, limit≤100)`; excludes own and non-open; signed-in only | Done — `/play` (`PlayBoard.tsx`: sport, today / week / any, "My level", area) | Missing | Suite §Y 81, §Z (anon sees no matches) |
| A2 | Games at one club | Done — `match_board(p_club, p_days)` | Done — club page `MatchBoard.tsx` | Missing | Club page has Book · Info only |
| A3 | Match detail | **Partial** — no single-match read. `match_board` is used for it, and it returns future matches only, ≤ 60 days ahead | Partial — `/matches/[id]` 404s once a match starts (finding S6) | Missing | Fix: `match_detail` (0067), draft validated — `02-safety-review.md` S6 |
| A4 | Participants | Done — `match_participants` (organiser sees pending; accepted members see accepted), `player_names` scoped | Done | Missing | Suite §T 55, §H 27 |
| A5 | Join / ask to join | Done — `join_match` (row lock, idempotent, auto-close when full) | Done | Missing | Suite §T 54, §U 58, §V 63–65 |
| A6 | Withdraw / leave | Done with a defect — `leave_match` deletes a *declined* row (S4) | Done | Missing | Suite §T 55, §V 66 |
| A7 | Approve / decline | Done — `decide_join` | Done | Missing | Suite §U 59, §V 65–67 |
| A8 | Post a game | Done with gaps — `post_match` with a booking (owner, confirmed, sport match, one live match per booking) or without (club optional, no date horizon: S10) | Done — club board form; booking page "Open to players" | Missing | Suite §W 70–72, §AF |
| A9 | Edit a game | Done — `update_match` (never below accepted count) | Done | Missing | Suite §AC |
| A10 | Make private / reopen / cancel | Done — `set_match_status` (closing deletes pending with a notice; cancel is final) | Done | Missing | Suite §T 56, §U 62, §AF |
| A11 | Remove a player | **Missing** | Missing | Missing | Only way today: cancel the game |
| A12 | Hand over organiser | **Missing** | Missing | Missing | Organiser leaving = cancel |
| A13 | Waiting list | Implicit — pending requests on a full approval game stay pending (S11) | Implicit | Missing | No notice to waiters |
| A14 | Invite a player | Missing (sharing the web URL only) | Share URL | Missing | Out of M3 scope (recommended) |
| A15 | Chat | Done with defects — direct insert under RLS (S2, S9), `match_messages_list(p_match, p_after)`, soft delete `delete_match_message`, `hide_match` | Done — full refetch every 5 s | Missing | Suite §U 58–61, §AF |
| A16 | Report / block | **Missing** | Missing | Missing | Store requirement for user content (S3) |
| A17 | In-app notifications | Done — `notifications` + `notify()`, 9 kinds, `mark_notifications_read`, `delete_notification`, `clear_notifications`; column-wide UPDATE grant (S5) | Done — Activity page, tab badge; opening any match marks **all** notices read | Missing | Suite §U 59–62 |
| A18 | Email fan-out | Done — `claim_notifications_to_email` (service role) | Done — `/api/notify/email`, cookie session only | Not reachable — the app has no cookie; G1 (`authenticateRequest`) is parked on `payments-g1` | S16 |
| A19 | Push | Missing (G3) | — | Missing | Planned for M3 |
| A20 | Levels on games | Done — `player_levels`, `match_level_bounds`, `my_level` on board rows | Done — `levels.ts` (`rangeLabel`, `fitLabel`, guide) | Partial — not copied into `mobile/shared/` yet | Setting levels in the app is M4 |
| A21 | Bookings → Games | Done — `my_agenda` returns `kind='match'` rows | Done | **Partial** — Games segment lists rows; rows are not tappable; empty state says "arrives in the next milestone" | `app/(tabs)/bookings.tsx` |
| A22 | Booking ↔ game link | **Partial** — trigger `sync_match_with_booking`: time follows a staff move; cancel unlinks but the game stays open to joins (S19); a no-show mark is treated as a cancellation (S18); pending not told (S8) | Done (same behaviour) | — | Suite §V 68, §W 72; redesign GR-9 |
| A23 | Staff view of games | Done — staff can read their club's games (RLS) | Web staff pages | Not in native scope (native app plan D4: staff stay on web) | — |

## 1.2 What the native app can reuse unchanged

**Database (no change needed for these):** `open_matches`, `match_board`, `my_agenda`,
`join_match`, `leave_match`, `decide_join`, `post_match`, `update_match`, `set_match_status`,
`match_participants`, `player_names`, `match_messages_list`, `delete_match_message`, `hide_match`,
`match_is_hidden`, `mark_notifications_read`, `delete_notification`, `clear_notifications`,
`booking_match`. RLS on `matches`, `match_players`, `match_messages`, `notifications`.

**Shared logic:** `src/lib/levels.ts` (labels, fit, guide) and the `friendlyError` map in
`src/lib/types.ts` (already copied to `mobile/shared/types.ts`; it holds the match error copy:
`match_full`, `match_closed`, `join_declined`, `organizer_cannot_join`, `booking_already_posted`,
`sport_mismatch` …). `levels.ts` must be added to `mobile/shared/` as a byte copy (the CI equality
check already covers that folder).

**Native building blocks already in M2:** `PlayerSlots` (initials + red dashed open spots + "2 spots
left" in words), `Chip`, `Segmented`, `DateStrip`, `SportMark`, `StateView` (loading / empty /
error), `Freshness`, `OfflineBanner`, `SignInPrompt`, `Ticket`, `Button`, `Icon`, `Text`;
`lib/errors.ts` (`classify` → network / auth / refused / unknown), `lib/queries.ts` patterns
(TanStack Query keys, refetch on focus and reconnect), `lib/bookings.ts` (`useAgenda`,
`splitAgenda`), haptics, theme tokens.

**Test infrastructure:** SQL suite (`supabase/tests/run.sh`, 381 checks; match sections T, U, V, W,
Y, Z, AA, AC, AE, AF, AH), staging smoke and API scripts, Maestro flows on the Android emulator,
the iOS accessibility audit, the staging tester account.

## 1.3 What must be built

| Layer | Item |
| --- | --- |
| Database | Four migrations (`02-safety-review.md` §2.3): 0067 `match_detail`; M3-H hardening incl. court-lost handling and `remove_player`; M3-S report / block / moderation; M3-D push delivery |
| Server | One Edge Function `deliver` draining the `notifications` queue on a schedule, for push and email (`05-architecture.md` §5.5) |
| Native | Find a Game board; match detail; join / request / withdraw / leave; organiser approve / decline / edit / private / reopen / cancel / remove; post from a booking and without one; chat; Activity with unread badge; push permission, registration, deep links; Club → Games section |
| Design | Board, match detail and chat designs approved before code (Stitch workflow, step 3) |

## 1.4 Facts verified for this audit

- Function bodies and policies were dumped from the local replica built from the migrations, not
  from live or staging.
- Every "Done" in the database column maps to an existing SQL suite section (named in the row).
- Every finding called REPRODUCED in `02-safety-review.md` was run on the local replica on
  16 Nov 2026 with `docs/m3/repro/m3_findings.sh`; output is quoted there.
