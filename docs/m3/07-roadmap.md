# M3 — 7. Staged roadmap, first slice and implementation order

Preconditions: M2 closed and merged (Galaxy A17 pass, Wed 18 Nov; final checks); Paul authorises M3.
Every migration: shown to Paul → staging → tested → live only with explicit approval. Live push stays
off until approved. Each stage ends with a staging update or build, Paul's device checks, and a short
report.

| Stage | Content | Migration | Native build | Acceptance |
| --- | --- | --- | --- | --- |
| **0. Ready** | P1–P4 accepted (16 Nov); M2 closed; Stitch round for board and detail (Paul) | — | — | Board and detail designs approved |
| **1. Read-only games** | 0067; board; game detail (all states); Club → Games; Bookings → Games tappable | **0067** | no (EAS update) | §7.2 |
| **2. Hardening** | M3-H + its web adjustments (P4) | **M3-H** | — | AP and AR green with mutations; `m3_findings.sh`: nothing reproduced on replica and staging; G6, G7; web regression on staging (web tests, smoke and API scripts, changed pages against the staging database) before any live release; Paul approves live |
| **3. Taking part** | Join / ask, withdraw, leave; accept / decline; remove; manage (edit, private, reopen, cancel); court booking cancelled sheet; post from booking and from the board | (M3-H) | no | E2E 10–13; D-2 without chat, D-7; every code in UX §4.8 for these actions reachable or proven unreachable |
| **4. Chat and safety** | Chat (4 s polling), delete, hide, community rules, report, block, filter; web admin "Reports" page (P2) | **M3-S** | no | AQ, AT; E2E 14–15; D-5; store UGC checklist (filter, report, block, contact, terms) |
| **5. Activity** | Activity list, per-game mark read, unread badge on Home and Profile | — | no | U1–U3; badge consistent across two phones within one refresh |
| **6. Push** | T-DL10–DL16 first (replica), then `deliver`, cron jobs (staging), tokens, pre-prompt, routing, Profile → Notifications | **M3-D** | **yes** (`expo-notifications`, version bump) | AS incl. T-DL10–DL16 before any delivery code; T-DL1–DL9 on staging; E2E 16; D-3, D-4 on iPhone and A17 incl. killed app. Production push only with explicit approval |
| **7. Close** | Full regression, accessibility audits, usability sessions (about 5 players), closure report | — | — | `06-test-plan.md` §6.8; release-plan M3 acceptance |

Why this order: the detail screen is built on `match_detail` from its first line (review point 2);
hardening lands before any native write; chat only after the timestamp fix; push last (needs a build
and credentials, and needs something to notify about).

## 7.1 Stitch review (already planned) — which screens, when

| Screen | When | Must show |
| --- | --- | --- |
| Find a game board + game card | Before stage 1 screens | dense vs readable card; filters; empty and offline states |
| Game detail | Before stage 1 screens | all GR-1 states incl. waiting list and court booking cancelled; player vs organiser |
| Chat | Before stage 4 | bubble hierarchy, day separators, report affordance, read-only states |

Not reviewed in Stitch: sheets, Activity (built from existing components). Stitch output is a
reference only; Paul approves; the Club Info design is not touched.

## 7.2 First slice — exact scope and acceptance

**Scope**

1. Migration 0067 (`docs/m3/sql/0067_match_detail.draft.sql` becomes the migration) + suite §AO
   (T-MD1–MD6) + staging API G1.
2. `mobile/shared/levels.ts` (byte copy).
3. `lib/games.ts`: `useOpenGames(filters)` (`open_matches`), `useClubGames(clubId)` (`match_board`,
   list only), `useGame(id)` (`match_detail`), `gameState(detail, now)`; hooks disabled when signed
   out. `lib/errors.ts`: game copy map.
4. Screens: Find a game (Home entry), Game detail (read-only), Club → Games segment, Bookings →
   Games rows tappable (future and past).
5. Read-only means: no write call exists in the slice. Action areas say "Joining from the app arrives
   in the next update." (non-members), "Managing games from the app arrives in the next update."
   (organiser); members see "Chat arrives in a later update."

**Not in the slice:** writes, chat, Activity, push, organiser actions.

**Acceptance (each item names how it is checked; none is assumed):**

| # | Requirement | Achievable with | Check |
| --- | --- | --- | --- |
| 1 | Board shows exactly what `open_matches` returns for the chosen filters | existing `open_matches` | U6 (params) + E2E 06 (seeded game appears, filtered-out game does not) |
| 2 | Signed-out users see the sign-in prompt and no game data; no game call is made | client gating | U9 + E2E 08 |
| 3 | Detail shows the right state, banner and wording for open, waiting, full, private, court booking cancelled, cancelled, playing, played — as organiser, accepted, pending and stranger | `match_detail` (0067); court-lost and played games seeded by service role on staging test data | E2E 07 + U1 |
| 4 | A stranger opening a private, cancelled or started game gets "isn't open any more, or isn't available to you" | `match_detail` returns no row (GR-2) | G1 + E2E 07 |
| 5 | Bookings → Games: every row opens its game, past ones included; hidden games stay out of the list | `my_agenda` (id = game id) + `match_detail` | E2E 09 |
| 6 | Club → Games lists that club's open games and mine, each opening its detail | `match_board(club, 14)` | E2E 06 variant |
| 7 | Unit U1, U2, U6, U7, U9 green | — | CI |
| 8 | Accessibility audits clean on the new screens (Android and iOS, normal and largest text) | — | CI / simulator |
| 9 | Change set limited to: `mobile/`, migration 0067, suite §AO, staging API G1. No web, payment, booking or M2-closed-work file changed | — | diff review |
| 10 | 0067 on staging: T-MD1–MD5 green on replica first, then G1 on staging; applied to live only after Paul's approval | — | run logs |
| 11 | Paul: D-1 and D-6 on iPhone and Galaxy A17 | — | phones |

Rollback: republish the previous staging update; 0067 is additive (a function and a nullable column
nothing else uses), so it can stay in place.

## 7.3 Implementation order (stage 1)

| Step | Work | Needs | Done when |
| --- | --- | --- | --- |
| 1 | 0067 migration + §AO tests (from the validated draft, matrix and field check); repeat the field review on the final text | M3 authorised (after M2 closes) | replica green incl. T-MD6; mutations fail it |
| 2 | Show 0067 to Paul; apply to staging; G1 | **Paul's separate approval for staging** | G1 green on staging |
| 3 | `shared/levels.ts`, `lib/games.ts`, `gameState`, error map, U1/U2/U6/U7/U9 | step 1 (types) | CI green |
| 4 | `GameCard`, detail sections, Club and Bookings wiring | approved Stitch designs | screens match the approved designs |
| 5 | E2E 06–09, accessibility audits; staging seed for states | steps 2–4 | CI green |
| 6 | Staging update; Paul's D-1, D-6 | step 5 | Paul's pass |
| 7 | 0067 to live (approval); stage report | Paul's approval | — |

Steps 1–3 need no design; step 4 waits for the Stitch approval.

## 7.4 Not done without a further go-ahead

Writing or applying any migration; any web change; enabling live push or cron jobs on live;
uploading FCM / APNs credentials; touching `mobile-m2-native`, `main` or `payments-g1`.
