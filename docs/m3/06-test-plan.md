# M3 — 6. Test plan

**Status of every test in this file: specified, not written, not run** — except the reproduction
script (§6.1), which was run on the local replica on 16 Nov 2026. Nothing below may be reported as
passing until it has been run and its output recorded.

Layers, cheapest first:

| Layer | Tool | Where | Runs |
| --- | --- | --- | --- |
| SQL | `supabase/tests/run.sh` (new sections AO–AS) | local replica | every PR; must fail when the protection is removed |
| Staging API | `supabase/tests/staging_api.mjs` (new section G) | staging project | before staging migration sign-off, before each release |
| Unit | Jest in `mobile/` | CI | every PR |
| E2E | Maestro flows, Android emulator | CI (Mobile E2E workflow) | every PR touching `mobile/` |
| Accessibility | Android TalkBack-label audit + iOS `performAccessibilityAudit` | CI / simulator | every new screen |
| Device | Paul's iPhone + Galaxy A17, two staging accounts | physical | each slice; push on both platforms |
| Independent | Manual VoiceOver / TalkBack tester | physical | before store submission (not Paul) |

## 6.1 Reproduction baseline (run, 16 Nov 2026, local replica)

`PSQL="sudo -u postgres psql" bash docs/m3/repro/m3_findings.sh`

| Item | Result today | After the hardening migration, expected |
| --- | --- | --- |
| F1 decline bypass | REPRODUCED | NOT REPRODUCED |
| F2 client timestamp | REPRODUCED | NOT REPRODUCED |
| F3 organiser delete | REPRODUCED | NOT REPRODUCED |
| F4 pending not told | REPRODUCED | NOT REPRODUCED |
| F5 pending on full game | REPRODUCED (behaviour) | waiting-list notice sent (if D5) |
| F6 club-less post | REPRODUCED | NOT REPRODUCED (`club_required`) |
| F7 no read after start | REPRODUCED | `match_detail` returns the row |
| F8 chat insert rules | REPRODUCED ×2 | NOT REPRODUCED ×2 |
| F9 notice rewrite | REPRODUCED | NOT REPRODUCED (permission denied) |
| C1, C2 concurrency | CONTROL OK | CONTROL OK |

The script becomes the migration's acceptance check: run before (all reproduced) and after (none).

## 6.2 SQL tests (new suite sections)

Each test states the fault it must catch; the "mutation" column is the deliberate break used to
prove the test can fail (M2 discipline).

### AO — hardening

| ID | Test | Expected | Mutation that must make it fail |
| --- | --- | --- | --- |
| T-S1 | Organiser `delete from matches` on own game with a player | 0 rows; game, player, chat intact; `set_match_status(cancelled)` still notifies | restore the DELETE policy |
| T-S2a | Member inserts `created_at = '2030-01-01'` | stored `created_at` within 5 s of `now()` | drop the trigger |
| T-S2b | Member inserts `deleted_at = now()` | stored `deleted_at` is null | trigger without the `deleted_at` line |
| T-S4 | Declined player: `leave_match` then `join_match` | `join_declined`; organiser has 1 `join_request` from them | old `leave_match` |
| T-S5a | User updates own notice `body` / `emailed_at` | `permission denied` | re-grant table UPDATE |
| T-S5b | User marks own notice read via `mark_notifications_read` and via `update … set read_at` | both work | revoke `read_at` too |
| T-S6a | Accepted member, game started 30 min ago: `match_detail` | 1 row, status, `finished=false` | `start_at > now()` filter |
| T-S6b | Finished game: member | 1 row, `finished=true` | — |
| T-S6c | Stranger, private game | 0 rows | visibility rule removed |
| T-S6d | Anon | 0 rows / not executable | grant to anon |
| T-S8 | Booking cancelled under a game with a pending requester | pending requester gets `booking_unlinked`; same for `booking_moved` | old recipient set |
| T-S9a | Member inserts 2000-char body (any `deleted_at`) | check violation | trigger without `deleted_at` reset |
| T-S9b | Member posts to a cancelled game | `match_cancelled` | status check removed |
| T-S10a | `post_match` without booking and without club | `club_required` | — |
| T-S10b | Without booking, start in 61 days | `too_far_ahead`; 59 days ok | — |
| T-S11 | Approval game fills with one request left | requester gets one `match_full_waiting`; second fill → no duplicate | — |
| T-S12a | 11th open future game by one organiser | `too_many_games` | — |
| T-S12b | 31st message in 10 min in one game | `slow_down` | — |
| T-S13 | Name of 61 characters; name "CourtBook" | check violation (after existing data verified) | — |
| T-S14 | Member hid the game; another member writes | no `match_message` for the hider | — |
| T-S15 | Approval → open with 2 pending and 1 place | earliest accepted, other pending; notices | — |

### AP — remove player (D3)

| ID | Test | Expected |
| --- | --- | --- |
| T-RP1 | Organiser removes accepted player before start | row gone, `player_removed` notice, full game reopens |
| T-RP2 | Non-organiser calls it | `forbidden` |
| T-RP3 | After start | `match_started` |
| T-RP4 | Removed player asks again | `join_declined` (removal is kept as declined) |
| T-RP5 | Removed player reads chat | 0 rows |

### AQ — report and block (S3)

| ID | Test | Expected |
| --- | --- | --- |
| T-S3a | Member reports a message in their game | 1 report; second identical report → idempotent |
| T-S3b | Stranger reports a message id from another game | `not_found` (no oracle) |
| T-S3c | A blocks B; B's open games on A's board / A's on B's | hidden both ways |
| T-S3d | B joins A's game | `blocked` |
| T-S3e | In a shared game, A's message list | B's rows flagged `blocked`; A gets no `match_message` from B |
| T-S3f | Message with a blocked term | `message_not_allowed` |
| T-S3g | Reports readable by players | 0 rows; admin sees them |
| T-S3h | First message before rules accepted | `rules_not_accepted` |

### AR — RLS regression for M3 acceptance ("non-member cannot read")

| ID | Test | Expected |
| --- | --- | --- |
| T-R1 | Stranger: `match_messages` select, `match_messages_list` | 0 rows |
| T-R2 | Stranger and pending requester: `match_participants` | 0 rows (current rule: organiser and accepted members only; others get counts and the organiser's name from the board/detail row) |
| T-R3 | Pending requester: chat | 0 rows (members are organiser + accepted) |
| T-R4 | Left / removed player: chat and participants | 0 rows |

### AS — push tables

| ID | Test | Expected |
| --- | --- | --- |
| T-P1 | `register_push_token` twice, same token | one row; `last_seen_at` updated |
| T-P2 | Same token registered by another account | moves to the new account (one row) |
| T-P3 | Users read others' tokens | 0 rows |
| T-P4 | Two concurrent push claims | disjoint sets (mirror of suite 69) |
| T-P5 | `unregister_push_token` | row gone |

## 6.3 Staging API (new section G of `staging_api.mjs`, two staging test accounts)

| ID | Flow | Expected |
| --- | --- | --- |
| G1 | A posts from a booking; B sees it in `open_matches` | visible with correct court |
| G2 | B asks; A sees request; A accepts; B's `my_agenda` has the game | each step visible to the other (M3 acceptance) |
| G3 | B sends a message; A lists it; stranger C lists nothing | RLS on staging |
| G4 | B leaves; A gets `player_left`; game reopens | — |
| G5 | Every F-item from §6.1, via the REST API with real JWTs | none reproduced |
| G6 | Deliver function with a test token (Expo sandbox) | one push per notice; duplicate webhook → still one |

## 6.4 Unit tests (`mobile/`)

| ID | Unit | Cases |
| --- | --- | --- |
| U1 | `gameState(row, me, now)` | open / pending / accepted / declined / waiting / full / private / cancelled / playing / played, organiser vs player |
| U2 | Error map | every code in UX §4.8 has a message; unknown → generic |
| U3 | Chat merge | overlap de-dup, order, deleted rows replaced on full refresh, optimistic → server swap, retry with same id |
| U4 | Push routing | each kind → route; missing `match_id` → Activity; cold start |
| U5 | Push copy builder (shared with `deliver`) | fixed copy per kind; never contains `body` (S7) |
| U6 | Filters → RPC params | sport / dates (Beirut day boundaries) / area / fit |
| U7 | `levels.ts` copy | byte-equal to `src/lib/levels.ts` (CI check) |
| U8 | Single in-flight | double tap → one call |

## 6.5 E2E (Maestro, Android emulator, staging)

| Flow | Steps | Asserts |
| --- | --- | --- |
| 06-find-and-open | sign in → Home → Find a game → filter padel → open card | detail shows time, club, spots |
| 07-request-approve | tester B asks (seeded approval game); API as A accepts; B refreshes | "You're in." |
| 08-chat | open chat, send, see bubble, server row via API | text present once |
| 09-leave | leave with confirm | Games row gone |
| 10-post-from-booking | booking → Find players → Post | game on board via API |
| 11-offline-game | airplane mode on detail | banner, actions disabled, no crash |
| 12-push-tap (emulator, FCM) | send test push → tap from killed app | detail of that game |

Each flow also runs the accessibility audit on its screens (labels, 48 dp, text 1.0/1.3/1.6).
iOS: the XCTest audit gains the board, detail, chat, activity screens (normal and largest text).

## 6.6 Device tests (Paul, phones, staging) — one list per slice

| ID | What Paul checks | Pass when |
| --- | --- | --- |
| D-1 | Board on iPhone and A17: cards readable, filters obvious | Paul can find a padel game this week in < 30 s |
| D-2 | Two accounts (Paul + tester on second phone): post → request → accept → chat → leave | each step appears on the other phone within 10 s (chat) / on refresh (others) |
| D-3 | Push for each kind, app open / background / killed, both platforms | right screen opens; Back returns to Home |
| D-4 | Permission pre-prompt timing and wording | appears once after first post/join; "Not now" respected |
| D-5 | Report and block a message | confirmation shown; blocked messages collapsed |
| D-6 | Large text (phone setting at max) on board, detail, chat | nothing clipped; wraps |

Paul does no VoiceOver / TalkBack walkthroughs; those go to the independent tester before store
submission.

## 6.7 Exit criteria for M3

1. All AO–AS tests pass and each fails under its mutation.
2. Reproduction script: no item reproduced on the replica and on staging (G5).
3. Staging API section G green.
4. Unit and E2E green on CI; accessibility audits clean (or findings accepted in writing).
5. Device list D-1 … D-6 passed on both phones.
6. Release-plan M3 acceptance (3 items) met — traced in `08-traceability.md`.
