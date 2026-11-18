# M3 — 6. Test plan

**Status: specified, not written, not run** — except the three scripts in §6.1, run on the local
replica on 16 Nov 2026. Nothing below may be reported as passing until it has been run and its
output recorded. Rule IDs (GR-n) are in `03-journeys.md` §3.0.

| Layer | Tool | Where | Runs |
| --- | --- | --- | --- |
| SQL | `supabase/tests/run.sh`, new sections AO–AT | local replica | every PR; each check must fail under its mutation |
| Staging API | `supabase/tests/staging_api.mjs`, new section G | staging | before each migration sign-off and release |
| Delivery | `deliver` test mode + SQL checks | staging | before live delivery is approved |
| Unit | Jest in `mobile/` | CI | every PR |
| E2E | Maestro, Android emulator, staging | CI | every PR touching `mobile/` |
| Accessibility | TalkBack-label audit (Android), `performAccessibilityAudit` (iOS) | CI / simulator | every new screen |
| Device | Paul's iPhone + Galaxy A17, two staging accounts | phones | per stage |
| Independent | Manual VoiceOver / TalkBack tester (not Paul) | phones | before store submission |

## 6.1 Scripts already run (16 Nov 2026, local replica)

| Script | Result | Becomes |
| --- | --- | --- |
| `repro/m3_findings.sh` | F1–F10 reproduced (F5 behaviour, F8 two parts); C1, C2 control OK | M3-H acceptance: run before (all reproduced) and after (none) on replica and staging |
| `repro/match_detail_matrix.sh` | `MATRIX PASS` (8 roles × 7 states), `FIELDS PASS`; mutations "no start-time limit" → `MATRIX FAIL`, "booking id to everyone" → `FIELDS FAIL`; anon → permission denied | T-MD1–MD6 in suite §AO |
| `repro/chat_cursor.sh` | strict cursor loses a delayed commit, overlap recovers it; deletion seen only by full reload — both CONFIRMED | U3 cases and T-CH1–CH2 |

## 6.2 SQL tests

### AO — 0067 `match_detail` (stage 1)

| ID | Test | Expected | Mutation that must fail it |
| --- | --- | --- | --- |
| T-MD1 | Matrix: organiser, accepted, pending, declined, removed, left, stranger, staff × open, full, private, cancelled, playing, played, court lost | as GR-2 (O, A, S all; P all but private; others open only) | drop "not started" limit; drop pending from the member rule |
| T-MD2 | Anon calls it | permission denied | grant to anon |
| T-MD3 | Request count | organiser: number; others: null | return it to all |
| T-MD4 | Flags | `started`, `finished` (end, or start + 3 h), `court_lost`, `hidden`, `my_status` incl. `declined` | — |
| T-MD5 | Migration applied twice | no error, one function | — |
| T-MD6 | Field review: every column for each role (`02-safety-review.md` S6 table) — `organizer_id`, `booking_id` only for organiser, accepted, staff, admin; `has_court` and court name for all who see the game; `note` only where the game is visible | as the table | return identifiers to all |

### AP — M3-H hardening (stage 2)

| ID | Test | Expected | Mutation |
| --- | --- | --- | --- |
| T-S1 | Organiser `delete from matches` on a game with a player | 0 rows; game, players, chat intact | restore the policy — **already satisfied by release fix 0069** (fixes suite S1a–c); kept as regression |
| T-S2a | Member inserts `created_at = 2030-01-01` | stored within 5 s of now | drop trigger |
| T-S2b | Member inserts `deleted_at = now()` | stored null | trigger without that line |
| T-S4 | Declined player leaves, asks again | `join_declined`; organiser has 1 request notice | old `leave_match` |
| T-S5a | User updates own notice `body` / `emailed_at` | permission denied | re-grant UPDATE — **satisfied by release fix 0069** (fixes S5a–f); regression |
| T-S5b | `mark_notifications_read` and `update … set read_at` | both work | revoke `read_at` |
| T-S8 | Booking moved; pending requester | gets `booking_moved` | old recipient set |
| T-S9a | Member inserts 2000-character body (any `deleted_at`) | check violation | — |
| T-S9b | Member writes in a cancelled game | `match_cancelled` | — |
| T-S10a/b | No booking, no club / start in 61 days (59 ok) | `club_required` / `too_far_ahead` | — |
| T-S11 | Approval game fills with 2 requests waiting; fills again after a leave | each waiting player 1 `match_full_waiting` per fill | — |
| T-S12a/b | 11th open game; 31st message in 10 min | `too_many_games` / `slow_down` | — |
| T-S14 | Member hid the game; another writes | no notice to the hider | — |
| T-S15 | Approval → open with 2 pending, 1 place | earliest accepted with notice, other stays waiting | — |
| T-RP1 | Organiser removes accepted player before start | gone, `player_removed`, `full` game reopens | — |
| T-RP2 | Non-organiser / admin | `forbidden` / allowed | — |
| T-RP3 | After start | `match_started` | — |
| T-RP4 | Removed player asks again | `join_declined` | store as left instead of declined |
| T-RP5 | Removed player reads chat, participants | 0 rows | — |
| T-RP6 | Remove from a `no_court` or private game | game stays as it was | reopen on any closed |
| T-GR8a | Make private / reopen after start | `match_started` | — |
| T-GR8b | Cancel after the game was played | `match_over` | — |
| T-GR8c | Cancel while playing | allowed, notices | — |
| T-GR8d | Edit after start | `match_closed` (existing) | — |
| T-GR8e | Organiser `leave_match` on own game | no row, no effect (existing); app hides it | — |
| T-CL1 | Linked booking `confirmed → cancelled`, open game, accepted A, pending P | `closed`/`no_court`, `court_lost`, no link; `booking_unlinked` to O, A, P (1 each) | old trigger |
| T-CL2 | Stranger joins; game on board | `match_closed`; not on `open_matches` | — |
| T-CL3 | Organiser accepts P / declines P | `match_closed` / allowed | — |
| T-CL4 | `set_match_status(open)` and `(closed)` while court lost | `court_lost` | — |
| T-CL5 | `resolve_court(null)`, not full | `open`, `court_lost` false, `court_resolved` to A and P | — |
| T-CL6 | Full game loses court, then `resolve_court(null)` | `closed`/`full` | resolve always to open |
| T-CL7 | Private game loses court | stays private; after resolve still private | — |
| T-CL8 | `resolve_court(booking)`: not mine / other sport / already linked / past / valid | `booking_not_found` / `sport_mismatch` / `booking_already_posted` / `slot_in_past` / linked, club + start + end follow the booking | — |
| T-CL9 | Non-organiser resolves; resolve when court not lost | `forbidden` / `court_not_lost` | — |
| T-CL10 | Played booking marked `no_show` | nothing changes, no notice (S18) | act on any non-confirmed |
| T-CL11 | Accepted player leaves a `no_court` full game | stays `no_court` | — |
| T-CL12 | Cancel a `no_court` game | `cancelled`, notices to A and P | — |
| T-SUITE | Existing §V 68 updated: cancel → `no_court` (was: stays open) | — | — |

### AQ — M3-S safety (stage 4)

| ID | Test | Expected |
| --- | --- | --- |
| T-S3a | Member reports a message; repeats | 1 report with snapshot; idempotent |
| T-S3b | Stranger reports a message of another game | `not_found` |
| T-S3c | A blocks B: boards, `match_detail` of open games | hidden both ways |
| T-S3d | B joins A's game | `blocked` |
| T-S3e | Shared game: A's list, A's notices | B's rows flagged; no `match_message` from B |
| T-S3f | Blocked term | `message_not_allowed` |
| T-S3g | Players read `reports` | 0 rows; admin reads |
| T-S3h | First message before rules accepted | `rules_not_accepted` |
| T-S13 | Name of 61 characters; "CourtBook" | refused |
| T-MOD1 | Message deleted by sender after report | report snapshot still has the text |
| T-MOD2 | `admin_hide_message` | message shows as removed to members |
| T-MOD3 | `admin_suspend`; suspended user joins, posts, writes | `account_suspended` each |
| T-MOD4 | Admin RPCs called by a player | `forbidden` |
| T-MOD5 | New report → one email to the support address (staging, test SMTP) | 1 email, `emailed_at` set |
| T-MOD6 | Retention job: report closed 181 days ago; another under `legal_hold` | first: snapshot and note cleared, row kept; second: untouched |
| T-MOD7 | Reported player and reporter read the report (table, RPCs) | nothing beyond the reporter's own "sent" state |

### AR — RLS regression ("a non-member cannot read")

| ID | Test | Expected |
| --- | --- | --- |
| T-R1 | Stranger: `match_messages`, `match_messages_list` | 0 rows |
| T-R2 | Stranger and pending requester: `match_participants` | 0 rows |
| T-R3 | Pending requester: chat | 0 rows |
| T-R4 | Left / removed player: chat, participants | 0 rows |

### AS — M3-D delivery tables

| ID | Test | Expected |
| --- | --- | --- |
| T-P1 | `register_push_token` twice | one row, `last_seen_at` updated |
| T-P2 | Same token from another account | moves to it |
| T-P3 | Read others' tokens | 0 rows |
| T-P4 | `unregister_push_token` | gone |
| T-DL2 | Two concurrent push claims | disjoint sets (mirror of suite 69) |
| T-DL3 | Claim, no stamp, lease expiry | claimable again; `push_attempts` 2 |
| T-DL4 | 3 attempts or older than 24 h | `push_failed_at`, never claimed again |

**Lease and overlapping-worker tests (Paul's safeguard 2) — must exist and pass on the replica before
`deliver` is written.** They drive the claim / re-check / stamp SQL functions directly from two
sessions, so the race is reproduced exactly rather than hoped for.

| ID | Scenario | Expected | Mutation that must fail it |
| --- | --- | --- | --- |
| T-DL10 | Worker A claims a batch; worker B claims while A's lease is live | B gets none of A's rows | claim without the lease condition |
| T-DL11 | A claims; lease forced to expire; B reclaims the same row; then A runs its pre-send re-check | A's re-check returns 0 rows → A sends nothing | re-check without `push_claim_id = mine` |
| T-DL12 | Same as T-DL11, then A tries to stamp its stale result | 0 rows updated; B's stamp intact | stamp without the claim-id condition |
| T-DL13 | A "sends" (ticket logged), dies before stamping; lease expires; B reclaims and sends | exactly 2 tickets for the notice, `push_attempts = 2`; stamped once | — |
| T-DL14 | Repeat T-DL13 until the cap | ≤ 3 tickets per notice, then `push_failed_at`; never claimed again | remove the attempt cap |
| T-DL15 | `deliver` started with lease < 2 × its deadline | refuses to start | remove the guard |
| T-DL16 | Email claim: stamp fails 3 times after sending | ≤ 3 claims of the row, then not claimable; web route still works with the same claim | remove `email_attempts` |

### AT — chat cursor (with M3-H trigger)

| ID | Test | Expected |
| --- | --- | --- |
| T-CH1 | `chat_cursor.sh` scenario with the trigger | overlap poll returns the delayed message |
| T-CH2 | Two inserts in one transaction | equal `created_at`; overlap poll returns both once after de-duplication (client test U3) |

## 6.3 Staging API (section G of `staging_api.mjs`, two test accounts)

| ID | Flow | Expected |
| --- | --- | --- |
| G1 | `match_detail` for seeded states (service-role seed, test club, cleaned after) | GR-2 table holds on staging |
| G2 | A posts from a booking; B sees it | visible with court |
| G3 | B asks; A accepts; B's `my_agenda` has it | each step visible to the other |
| G4 | B writes; A reads; stranger C reads nothing | RLS on staging |
| G5 | B leaves; A notified; game reopens | — |
| G6 | All F-items via REST with real JWTs (after M3-H) | none reproduced |
| G7 | A cancels the linked booking → GR-9 end to end, then `resolve_court` | T-CL1, T-CL5 on staging |

## 6.4 Delivery on staging (`deliver`, before live approval)

| ID | Scenario | Pass when |
| --- | --- | --- |
| T-DL1 | 50 notices, one worker | each pushed once (count Expo tickets per notice) |
| T-DL5 | Function killed mid-batch (test switch) | unsent rows delivered after the lease; duplicates counted and ≤ the killed batch's in-flight rows |
| T-DL6 | Two workers started together | no notice sent twice |
| T-DL7 | Dead token (uninstalled test app) | token deleted after ticket or receipt check |
| T-DL8 | Staging function given a token marked `production` | skipped, logged |
| T-DL9 | `DELIVERY_ENABLED=false` | nothing sent, rows stay queued |

## 6.5 Unit tests (`mobile/`)

| ID | Unit | Cases |
| --- | --- | --- |
| U1 | `gameState(detail, now)` | every state of GR-1 × organiser / accepted / pending / waiting / declined; court lost; no court |
| U2 | Error map | every code in UX §4.8 has copy; unknown → generic; `match_closed` + court lost → paused copy |
| U3 | Chat merge | overlap de-dup; equal timestamps; order `(created_at, id)`; full reload replaces deleted; optimistic → server swap; retry same id |
| U4 | Push routing | each kind → route; missing `match_id` → Activity; cold start |
| U5 | Push copy builder (shared with `deliver`) | copy per kind; never contains `notifications.body` |
| U6 | Filters → RPC params | sport, Beirut day boundaries, area, fit |
| U7 | `levels.ts` copy | `check:shared` |
| U8 | Single in-flight | double tap → one call |
| U9 | Hooks disabled when signed out | no RPC issued |

## 6.6 E2E (Maestro, Android emulator, staging)

| Flow | Stage | Asserts |
| --- | --- | --- |
| 06-board-and-detail | 1 | board → padel filter → card → detail time, club, spots |
| 07-detail-states | 1 | seeded private (member), cancelled, playing, court lost → right banner and actions |
| 08-signed-out | 1 | Find a game shows the sign-in prompt |
| 09-games-row | 1 | Bookings → Games row opens the game (future and past) |
| 10-request-approve | 3 | B asks; A accepts via API; B sees "You're in." |
| 11-leave | 3 | confirm, row gone |
| 12-post-from-booking | 3 | game on the board via API |
| 13-court-lost | 3 | booking cancelled via API → banner; organiser resolves |
| 14-chat | 4 | send, one bubble, server row once |
| 15-report-block | 4 | report sent; blocked messages collapsed |
| 16-push-tap | 6 | test push → killed app → right game |

Each flow runs the accessibility audit on its screens (labels, 48 dp, text 1.0 / 1.3 / 1.6); the iOS
audit adds board, detail, chat, activity (normal and largest text).

## 6.7 Device checks (Paul, staging, both phones)

| ID | Stage | Check | Pass when |
| --- | --- | --- | --- |
| D-1 | 1 | Board and detail readable; filters obvious | a padel game this week found in under 30 s |
| D-6 | 1 | Largest phone text on board and detail | nothing clipped |
| D-2 | 3–5 | Two accounts: post → request → accept → chat → leave | each step shows on the other phone (chat within ~10 s, others on refresh) |
| D-7 | 3 | Court booking cancelled → banner on both phones; organiser resolves | both phones show the paused state, then the update |
| D-3 | 6 | Push per kind: open, background, killed | right screen; Back → Home |
| D-4 | 6 | Pre-prompt timing and wording | once after first post / join |
| D-5 | 4 | Report and block | confirmation; blocked messages collapsed |

## 6.8 Exit criteria for M3

1. AO–AT pass; each check fails under its mutation.
2. `m3_findings.sh`: nothing reproduced on replica and staging (G6).
3. Staging API section G and delivery T-DL green.
4. Unit and E2E green on CI; accessibility audits clean or findings accepted in writing.
5. Device checks passed on both phones.
6. Release-plan M3 acceptance met (`08-traceability.md`).
