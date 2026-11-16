# M3 — Find a Game: preparation package

Branch `m3-prep`, started from `cec5a95` (the frozen M2 head). **Documentation and test
specifications only.** Prepared 16 Nov 2026 for Paul's review with ChatGPT before any M3 code is
authorised.

| File | Contents |
| --- | --- |
| `01-audit.md` | What exists (database, web, native), what is partial or missing, what is reusable |
| `02-safety-review.md` | Findings S1–S17 with object, severity, reproduction, correction, settling test; controls C1–C6; the proposed hardening migration |
| `03-journeys.md` | Ten native journeys with edge cases and exact messages |
| `04-ux-spec.md` | Screens in Court Lines, message table for every server code, push copy, Stitch candidates |
| `05-architecture.md` | Data layer, write safety, chat polling, push/email delivery, report/block, security checklist |
| `06-test-plan.md` | SQL, staging API, unit, E2E, accessibility and device tests; exit criteria |
| `07-roadmap.md` | Stages 0–7 with acceptance; the first safe slice |
| `08-traceability.md` | Requirement → journey → UX → architecture → finding → test → stage |
| `09-decisions.md` | Twelve decisions with recommended defaults |
| `repro/m3_findings.sh` | Reproductions F1–F9 and controls C1–C2 (local replica only) |

## Headline

- The database already supports almost all of Find a Game; the web uses it in production.
  The native app needs screens, a thin data layer, push delivery, and report/block.
- **Five defects present on live today** should be fixed before native write screens: organiser can
  delete a shared game (S1), chat timestamps are sender-controlled (S2), a declined player can
  re-request without limit (S4), users can rewrite and re-queue their notifications (S5), and no
  game can be read once it starts (S6). All reproduced on the local replica; fixes are web-compatible.
- **Report and block (S3)** are required by both stores for chat.
- **First slice:** read-only board and game detail on existing functions — no database change.

## How the reproductions were run

```
service postgresql start
PSQL="sudo -u postgres psql" bash supabase/tests/run.sh        # builds courtbook_test from all migrations
PSQL="sudo -u postgres psql" bash docs/m3/repro/m3_findings.sh # refuses anything but the local replica
```

Result on 16 Nov 2026: F1–F9 REPRODUCED (F5 is behaviour to define; F8 has two parts), C1 and C2
CONTROL OK.

## What was changed, and what was not

**Changed:** new files under `docs/m3/` on branch `m3-prep` only. The local throwaway replica
`courtbook_test` was rebuilt and used for the reproductions.

**Not changed:** no application code (web or mobile), no migration, no database function, policy
or grant, no live or staging database, no deployment, no EAS build or update, no payment code,
no Club Info / Sentry / booking-recovery work, branch `mobile-m2-native` (still at `cec5a95`),
`main`, `payments-g1`. No test in `06-test-plan.md` has been written or run.
