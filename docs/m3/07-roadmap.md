# M3 — 7. Staged roadmap and first slice

Precondition for all stages: M2 closed and merged (Galaxy A17 pass on Wed 18 Nov, final checks),
and Paul's authorisation of M3 after the ChatGPT review of this package. Each stage ends with a
staging build/update, Paul's phone check against its device list, and a short report. Database
changes: staging first, live only with Paul's explicit approval. Live push stays off until approved.

| Stage | Content | Database change | Native build needed | Acceptance (all must hold) |
| --- | --- | --- | --- | --- |
| **0. Approvals** | ChatGPT review of this package; decisions D1–D12; Stitch round for board, detail, chat (Paul) | none | — | Decisions recorded; designs approved by Paul |
| **1. Read-only games (first slice)** | Board, game detail (future games), Bookings → Games tappable, Club → Games segment | **none** | no (EAS update) | §7.1 |
| **2. Hardening migration** | §2.3 items S1, S2, S4, S5, S6 (`match_detail`), S8, S9, S10, S11, S12, S14, S15, `remove_player` | one migration | — | AO, AP, AR green on replica with mutations; repro script: none reproduced on replica **and** staging; web smoke on staging unchanged; Paul approves before live |
| **3. Taking part** | Join / ask, withdraw, leave, organiser accept / decline / remove, manage (edit, private, reopen, cancel), post from booking and from board | (uses stage 2) | no | E2E 07, 09, 10; device D-2 without chat; every error code in UX §4.8 reachable or proven unreachable |
| **4. Chat + safety** | Chat (polling), delete, hide, community rules, report, block, blocked-terms filter | report / block / rules (second migration, or folded into stage 2 if approved together) | no | AQ green; E2E 08; device D-5; store UGC checklist (filter, report, block, contact) ticked |
| **5. Activity** | Activity list, per-game mark read, unread badge on Home and Profile | none | no | Unit U1–U3; badge correct across two phones within one refresh |
| **6. Push (G3)** | `push_tokens`, prefs, `deliver` Edge Function + webhook, receipts job, pre-prompt, routing, Profile → Notifications | push tables; webhook + function on staging | **yes** (`expo-notifications`, version bump) | AS green; staging API G6; E2E 12; device D-3, D-4 on iPhone and A17 incl. killed app |
| **7. M3 close** | Full regression, accessibility audits, usability sessions (≈5 players), closure report | — | — | `06-test-plan.md` §6.7 exit criteria; release-plan M3 acceptance |

Order rationale: read-only first (no risk, earliest feedback on the board design); hardening before
any write screen, so no native write ever runs on the defective paths; chat only after S2 is fixed;
push last because it needs a native build and new credentials, and is useless before there is
something to be told about.

## 7.1 First safe slice — read-only games

**Why it is safe:** it calls only existing read functions already used by the web in production
(`open_matches`, `match_board`, `my_agenda`), under the same RLS; it writes nothing; it changes no
database, no web file, no payment code; it ships to staging only as an EAS update on the M2 build
(no native module).

**Scope:**

1. `mobile/shared/levels.ts` (byte copy; `npm run check:shared` covers every file in that folder
   automatically).
2. `lib/games.ts`: `useOpenGames(filters)`, `useClubGames(clubId)`, `useGame(id)` (from
   `match_board(null, 60)` filtered by id until `match_detail` exists), `gameState()` pure function.
3. `lib/errors.ts`: game copy map (read errors only used yet).
4. Screens: Find a game (Home entry), Game detail (read-only: hero, status, `PlayerSlots`, level,
   note, organiser; the action area says "Joining from the app arrives in the next update." — no
   button), Club → Games segment, Bookings → Games rows
   tappable for future games (past rows stay as now).
5. States: signed-out prompt, empty, error, offline, "isn't available".

**Out of the slice:** every write, chat, Activity, push, past/under-way detail (needs
`match_detail`).

**Acceptance (all to be run, none assumed):**

| # | Check | How |
| --- | --- | --- |
| 1 | Board shows the same games as the web `/play` for the same filters and account | staging, side by side, 3 filter combinations |
| 2 | Signed-out user sees the sign-in prompt, never game data | E2E + network log: no `open_matches` call without a session |
| 3 | A private or cancelled game is not on the board; its detail shows the right state to a member and "isn't available" to a stranger | staging seed + E2E 06 |
| 4 | Bookings → Games: future rows open the game; past rows unchanged | E2E |
| 5 | Unit U1, U2, U6, U7 green | CI |
| 6 | Accessibility audits clean on the new screens (Android and iOS, normal and largest text) | CI / simulator |
| 7 | No change outside `mobile/`; no migration; web tests and SQL suite unchanged | diff review |
| 8 | Paul: D-1 and D-6 on iPhone and A17 | phones |

**Effort:** small (the data layer is a thin wrapper; screens use existing components).
**Rollback:** republish the previous staging update (pipeline already proven in M1).

## 7.2 What I will not do without a further go-ahead

Write the hardening migration (stage 2) or apply anything to staging or live; enable live push;
upload FCM/APNs credentials; change any web file; touch the M2 branch.
