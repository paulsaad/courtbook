# M3 — 8. Traceability matrix

Rows: every M3 requirement from the native release plan (scope and acceptance), the store rules
for user content, and the findings. Columns point to the section that answers it in this package.
"Test" IDs are specified in `06-test-plan.md` and **not yet run**.

## 8.1 Requirements → design → tests → stage

| Req | Requirement (source) | Journey | UX | Architecture | Findings | Tests | Stage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Play board with filters: sport, area, level, date (release plan M3) | J1 | §4.3 | §5.1–5.2 | — | U6, E2E 06, D-1 | 1 |
| R2 | Match details (plan) | J2 | §4.4 | §5.2 | S6 | T-S6a–d, U1, E2E 06 | 1 (future), 2 (`match_detail`) |
| R3 | Join and leave (plan) | J3, J4 | §4.4, §4.8 | §5.3 | S4 | T-S4, E2E 09, C1 | 3 |
| R4 | Organiser approve or decline (plan) | J5 | §4.4 | §5.3 | S11, S15 | T-S11, T-S15, C2, E2E 07 | 3 |
| R5 | Open a booking to players / make private (plan) | J6, J7 | §4.6 | §5.3 | S10 | T-S10a–b, E2E 10 | 3 |
| R6 | Players wanted (plan) | J6, J7 | §4.6 | — | S12 | T-S12a | 3 |
| R7 | Bookings → Games (plan) | J2 | §4.2 | §5.2 | — | slice check 4 | 1 |
| R8 | Chat (plan) | J8 | §4.5 | §5.4 | S2, S9, S14 | T-S2a–b, T-S9a–b, T-S14, U3, E2E 08 | 4 |
| R9 | In-app activity with unread badge (plan) | J9 | §4.7 | §5.7 | S5, S17 | T-S5a–b, U4 | 5 |
| R10 | Push for existing notification types; permission asked at a moment that explains why (plan, G3) | J10 | §4.6, §4.9 | §5.5, §5.8 | S7, S16 | T-P1–P5, U4, U5, G6, E2E 12, D-3, D-4 | 6 |
| R11 | Two accounts complete post → request → approve → chat → leave, each step visible to the other (plan acceptance) | J3–J6, J8, J9 | — | §5.2 | — | G1–G4, D-2 | 3–5 |
| R12 | A non-member cannot read a chat or a participant list — RLS on staging (plan acceptance) | J2, J8 | — | §5.9 | S1 | T-R1–R4, G3 | 2–4 |
| R13 | Push for each type opens the right screen, incl. killed app, iOS and Android (plan acceptance) | J10 | §4.9 | §5.8 | — | U4, E2E 12, D-3 | 6 |
| R14 | Definition of done: accessibility floor, tests, staging first (plan) | all | §4.1 | §5.9 | — | a11y audits, §6.7 | each |
| R15 | Report content and users; block users; filter; contact info (Apple 1.2, Google Play UGC) | J8 | §4.5, §4.6 | §5.6 | S3, S13 | T-S3a–h, T-S13, D-5 | 4 |
| R16 | Organiser cannot erase a shared game or its chat | J7 | §4.6 | §5.6 | S1 | T-S1 | 2 |
| R17 | Delivery independent of the client; staging/live isolation; live push off until approved | J10 | — | §5.5 | S16 | G6 | 6 |
| R18 | Remove a player (D3) | J7 | §4.6 | — | A11 | T-RP1–RP5 | 2–3 |
| R19 | Linked booking moved / cancelled is visible to everyone involved (D6) | J7 | §4.4 | — | S8 | T-S8 | 2 |
| R20 | Design approved before screen code (Stitch workflow) | — | §4.10 | — | — | Paul's approval | 0 |

## 8.2 Findings → fix → test

| Finding | Fix (safety review) | Test | Stage |
| --- | --- | --- | --- |
| S1 | drop DELETE policy, revoke DELETE | T-S1 | 2 |
| S2 | chat insert trigger | T-S2a–b | 2 |
| S3 | reports, blocks, filter, rules | T-S3a–h | 4 |
| S4 | `leave_match` keeps declined | T-S4 | 2 |
| S5 | UPDATE only on `read_at` | T-S5a–b | 2 |
| S6 | `match_detail` | T-S6a–d | 2 |
| S7 | push copy from kind | U5 | 6 |
| S8 | pending recipients | T-S8 | 2 |
| S9 | trigger: `deleted_at`, cancelled | T-S9a–b | 2 |
| S10 | club required, 60 days | T-S10a–b | 2 |
| S11 | waiting-list notice | T-S11 | 2 |
| S12 | counters | T-S12a–b | 2 |
| S13 | name check | T-S13 | 2 (if data allows) |
| S14 | skip hidden | T-S14 | 2 |
| S15 | approval → open | T-S15 | 2 |
| S16 | webhook dispatcher | G6 | 6 |
| S17 | native per-game read | U4 | 5 |

## 8.3 Paul's request → where it is answered

| Part | Answered in |
| --- | --- |
| 1 Audit | `01-audit.md` |
| 2 Safety and security review | `02-safety-review.md`, `repro/m3_findings.sh` |
| 3 Native journeys | `03-journeys.md` |
| 4 UX / UI in Court Lines, Stitch candidates | `04-ux-spec.md` (§4.10) |
| 5 Engineering architecture | `05-architecture.md` |
| 6 Test plan | `06-test-plan.md` |
| 7 Roadmap and first slice | `07-roadmap.md` |
| 8 Cross-check, docs, traceability | this file, `README.md` |
| Decisions | `09-decisions.md` |
