# M3 — 8. Traceability matrix

Rows: every M3 requirement (release plan scope and acceptance, store rules, Paul's review of
16 Nov) and every finding. Test IDs are in `06-test-plan.md`; only the §6.1 scripts have been run.

## 8.1 Requirements → rules → design → tests → stage

| Req | Requirement (source) | Rules | Journey | UX | Arch. | Findings | Tests | Stage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Play board with filters: sport, area, level, date (plan) | GR-2 | J1 | §4.3 | §5.2 | — | U6, E2E 06, D-1 | 1 |
| R2 | Match details (plan); secure read-only `match_detail` first (review 2) | GR-1, GR-2 | J2 | §4.4 | §5.2 | S6 | T-MD1–MD5, G1, U1, E2E 07 | 1 |
| R3 | Join and leave (plan) | GR-3, GR-7 | J3, J4 | §4.4, §4.8 | §5.3 | S4 | T-S4, C1, E2E 10–11 | 3 |
| R4 | Organiser approve or decline (plan) | GR-4, GR-5 | J5 | §4.4 | §5.3 | S11, S15 | T-S11, T-S15, C2, E2E 10 | 3 |
| R5 | Open a booking to players / make private (plan) | GR-8, GR-10 | J6, J7 | §4.6 | §5.3 | S10 | T-S10a–b, T-GR8a, E2E 12 | 3 |
| R6 | Players wanted (plan) | GR-8 | J6, J7 | §4.6 | — | S12 | T-S12a | 3 |
| R7 | Bookings → Games (plan) | GR-2 | J2 | §4.2 | §5.2 | — | E2E 09 | 1 |
| R8 | Chat (plan); polling verified (review 4) | GR-12 | J8 | §4.5 | §5.4 | S2, S9, S14 | T-S2a–b, T-S9a–b, T-S14, T-CH1–CH2, U3, E2E 14 | 4 |
| R9 | Activity with unread badge (plan) | — | J9 | §4.7 | §5.7 | S5, S17 | T-S5a–b, U4 | 5 |
| R10 | Push for existing types; permission asked in context (plan, G3) | — | J10 | §4.6, §4.9 | §5.5, §5.8 | S7, S16 | T-P1–P4, U4, U5, E2E 16, D-3, D-4 | 6 |
| R11 | Two accounts: post → request → approve → chat → leave, visible to each other (plan acceptance) | GR-3–GR-7 | J3–J6, J8, J9 | — | §5.2 | — | G2–G5, D-2 | 3–5 |
| R12 | Non-member cannot read chat or participants, RLS on staging (plan acceptance) | GR-2, GR-12 | J2, J8 | — | §5.9 | S1 | T-R1–R4, G4 | 1–4 |
| R13 | Push opens the right screen incl. killed app, iOS and Android (plan acceptance) | — | J10 | §4.9 | §5.8 | — | U4, E2E 16, D-3 | 6 |
| R14 | Definition of done: accessibility floor, tests, staging first (plan) | — | all | §4.1 | §5.9 | — | audits, §6.8 | each |
| R15 | Report, block, filter, contact, terms (Apple 1.2, Google Play UGC; review 5) | GR-12 | J8 | §4.5, §4.6 | §5.6 | S3, S13 | T-S3a–h, T-S13, T-MOD1–MOD5, D-5 | 4 |
| R16 | Realistic moderation process, no unproven response-time promise (review 5) | — | J8 | §4.6 | §5.6 | S3 | T-MOD1–MOD5 | 4 |
| R17 | Organiser cannot erase a shared game or its chat | GR-8 | J7 | §4.6 | — | S1 | T-S1 | 2 |
| R18 | Delivery: duplicates, failures, retries, concurrency, dead tokens, staging/live (review 3) | — | J10 | — | §5.5 | S16 | T-DL1–DL9 | 6 |
| R19 | Remove a player (D3) | GR-6 | J7 | §4.6 | — | A11 | T-RP1–RP6 | 2–3 |
| R20 | Court booking cancelled: keep game and chat, mark it, pause joins and approvals, organiser cancels or arranges another venue, everyone told, no automatic re-booking (review 1) | GR-9, GR-10 | J2, J3, J5, J7 | §4.4, §4.6, §4.9 | §5.3 | S8, S18, S19 | T-CL1–CL12, G7, E2E 13, D-7 | 1 (display), 2–3 |
| R21 | Waiting list, removal, cancellation and organiser permissions consistent across UX, DB, tests (review 6) | GR-4, GR-6, GR-8, GR-11 | J2, J5, J7 | §4.4, §4.6 | — | — | T-S11, T-RP*, T-GR8a–e, §U 62 | 2–3 |
| R22 | Every stage-1 acceptance item achievable with available backend functions (review 6) | — | — | — | — | — | `07-roadmap.md` §7.2 column "Achievable with" | 1 |
| R23 | Design approved before screen code | — | — | §4.10 | — | — | Paul's approval | 0, 4 |

## 8.2 Findings → fix → test → migration

| Finding | Fix | Tests | Migration |
| --- | --- | --- | --- |
| S1 | drop DELETE policy, revoke DELETE | T-S1 | 0068 |
| S2 | chat insert trigger (server time) | T-S2a–b, T-CH1 | 0068 |
| S3 | reports, blocks, filter, rules, moderation RPCs | T-S3a–h, T-MOD1–MOD5 | 0069 |
| S4 | `leave_match` keeps declined | T-S4 | 0068 |
| S5 | UPDATE only on `read_at` | T-S5a–b | 0068 |
| S6 | `match_detail` | T-MD1–MD5 | 0067 |
| S7 | push copy from kind | U5 | 0070 / `deliver` |
| S8 | pending recipients | T-S8, T-CL1 | 0068 |
| S9 | trigger: `deleted_at`, cancelled | T-S9a–b | 0068 |
| S10 | club required, 60 days | T-S10a–b | 0068 |
| S11 | waiting-list notice | T-S11 | 0068 |
| S12 | counters | T-S12a–b | 0068 |
| S13 | name rule | T-S13 | 0069 |
| S14 | skip hidden | T-S14 | 0068 |
| S15 | approval → open | T-S15 | 0068 |
| S16 | queue + scheduled `deliver` | T-DL1–DL9 | 0070 |
| S17 | native per-game mark read | U4 | — |
| S18 | ignore no-show | T-CL10 | 0068 |
| S19 | GR-9 + `resolve_court` | T-CL1–CL12 | 0067 (column, state) + 0068 |

## 8.3 Paul's review (16 Nov) → where it is answered

| Point | Answer |
| --- | --- |
| 1 Cancelled court booking | GR-9 in `03-journeys.md`; S19 / S18 in `02-safety-review.md`; J7 sheet; tests T-CL1–CL12 |
| 2 `match_detail` first | Draft `sql/0067_match_detail.draft.sql`, matrix run; GR-2; stage 1 rebuilt on it (`07-roadmap.md`) |
| 3 Delivery reliability | `05-architecture.md` §5.5; tests T-DL1–DL9 |
| 4 Chat polling | `05-architecture.md` §5.4; `repro/chat_cursor.sh` |
| 5 Moderation | `05-architecture.md` §5.6; report copy without a time promise (`04-ux-spec.md` §4.6) |
| 6 Decisions, consistency, stage-1 achievability | `09-decisions.md`; GR table; `07-roadmap.md` §7.2 |
| 7 Implementation readiness | `07-roadmap.md` §7.1–7.3; `02-safety-review.md` §2.5; `README.md` readiness report |
