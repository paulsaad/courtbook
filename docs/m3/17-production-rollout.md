# M3 — production rollout plan (20 Nov 2026)

**Website and database rollout COMPLETE (21 Nov 2026):** live database 0001–0075, production website
`main` = `207a55e`, Admin → Reports "No open reports". Mobile: `18-mobile-release.md`.

Inputs: staging verified (0067–0075, phones, website); live = 0001–0066 (0065–0066 present, 0067–0075 and
release fixes 0068–0071 absent; 1 admin; 0 real clubs, 1 demo; 0 holds; 0 upcoming bookings; 4 games
not cancelled); **verified live backup #12** (run 44820813184: 65 tables, 113 checks, 0 different;
`courtbook-live-20261120-2135.tar.gpg`, sha256 `946564…7c`, two copies kept). Nothing below is done
without Paul's approval.

## 1. Live migrations — order and dependencies

Run by Paul in Supabase → **live** → SQL Editor, one script at a time, with me reading each result. Every
apply script stops by itself unless the database is exactly in the expected state. Files:
`supabase/live/` and `supabase/migrations/` on `m3-dev`.

**Part A — safe with the current production website**

| # | Script(s) | Expect |
| --- | --- | --- |
| A1 | `fixes_preflight.sql` (read only, once) | every row true |
| A2 | `0068_apply.sql` | done |
| A3 | `0069_apply.sql` | done |
| A4 | `fixes_0070_clubs.sql` (read only) → `0070_apply.sql` | no club with will_switch = true, 0 holds released |
| A5 | `0071_apply.sql` → `fixes_postcheck.sql` | postcheck all true |
| A6 | `0067_preflight.sql` → `0067_apply.sql` → `0067_postcheck.sql` | all true |
| A7 | `0072_preflight.sql` → `0072_apply.sql` → `0072_postcheck.sql` | all true (needs A1–A6) |
| A8 | `0073_preflight.sql` → `migrations/0073_post_match_token.sql` → `0073_postcheck.sql` | all true |

**Then the website release (section 3, step 3)** — the current production website cannot show the
community-rules prompt that 0074 requires before a first chat message; the new website handles 0074 and
0075 whether or not they are applied. Between A7 and the website release, production shows a game with
a cancelled court as "Private" and a few new refusals as codes: keep A7 → website release in one session.

**Part C — after the new website is live**

| # | Script(s) | Expect |
| --- | --- | --- |
| C1 | `0074_preflight.sql` → `migrations/0074_safety.sql` → `0074_postcheck.sql` | all true; at least 1 admin |
| C2 | `0075_preflight.sql` → `migrations/0075_report_history.sql` → `0075_postcheck.sql` | all true |

Undo: each step has its rollback script; roll back newest first. The backup is the last resort.

## 2. Genuine blockers

- **Database and website: none.** Staging passed every check, live has no real club, hold or booking,
  and a verified backup exists. Take a fresh backup first only if the session is not today.
- **Live moderator:** live has exactly 1 admin. Confirmed for free after the website release: your
  account opening production Admin → Reports must show "Reports are not available on this database yet
  (migration 0074)", not "Admins only". If it says "Admins only", stop before C1.
- **Mobile apps — blocked on native builds.** No live app can take M3 as an update (fingerprint check,
  runs 44824602355 / 44824908184, nothing published): live iOS is a 0.2.0 build (runtime 0.2.0; M3 adds
  Sentry), and there is no live Android build at all. Live release needs new native builds on the
  live channel, which should also carry the pending native corrections (`release-native-fixes`
  `1c8b9b8`: iOS privacy manifest and the native config check — not yet in `m3-dev`), plus the one-line
  code change that turns game features on for live (today: staging only). The installed 0.2.0 app keeps
  working through every migration above (none changes what it calls).
- **Store submission (later, not this rollout):** moderator and review frequency, 180-day evidence
  clearing, objectionable-content decision, final privacy policy and terms, accessibility check.

## 3. Release order

1. Part A (A1–A8).
2. Quick production check: website loads; Play board and a game open.
3. **Merge `m3-dev` → `main`** — production website. Production keeps its own Vercel variables (the
   staging ones are scoped to the `m3-dev` preview). Check: Play, a game page, Admin → Reports shows
   "not available yet".
4. Part C (C1–C2). Check: Admin → Reports shows "No open reports".
5. Mobile: code change (live game features) + native corrections + version bump → native builds for the
   live channel (iOS, Android) → your phone check → later updates by OTA.
6. Clean-up: delete `LIVE_DB_URL` (or reset the database password); update docs.

## 4. Approvals needed

1. **Part A** live migrations (A1–A8), one session, you running each script with me.
2. **Merge `m3-dev` into `main`** (production website), right after Part A.
3. **Part C** (0074, 0075) after the production check.
4. **Mobile:** include `release-native-fixes`, the live game-features switch and a version bump, then
   native builds for the live channel — a separate decision; no live app update before that.
5. **Clean-up** of the live credential after the release.

## 5. Progress and packages (20 Nov 2026)

Live is now 0001–0073 (0074, 0075 pending). Done on live: A1 preflight (15/15), 0068, 0069, 0070 club review (demo only, nothing switched), 0070, 0071,
release-fixes postcheck (11/11). The rest goes in three packages, each one review, one approval, one run:

| Package | Scripts | Expect |
| --- | --- | --- |
| 1. Database: 0067 + 0072 + 0073 — **COMPLETE on live, 20 Nov 2026** | `pkg1_preflight.sql` → `pkg1_apply.sql` (one transaction: all three or none) → `pkg1_postcheck.sql` | done: preflight 18/18 true, `package 1 applied: 0067, 0072, 0073`, postcheck 29/29 true |
| 2. Website — **COMPLETE, 20 Nov 2026** | merge `m3-dev` (`6df8f31`) → `main` = `207a55e`; Vercel production deployment succeeded; no migration or mobile update triggered | done: Play loads, game pages open, Admin → Reports "not available yet (migration 0074)" |
| 3. Database: 0074 + 0075 — **COMPLETE on live, 21 Nov 2026** (postcheck 42/42; Admin → Reports "No open reports") | `pkg3_preflight.sql` → `pkg3_apply.sql` (one transaction: both or none) → `pkg3_postcheck.sql` | part 1 17/17 true (part 2: 1 admin) → `package 3 applied: 0074, 0075` → 42/42 true; then Admin → Reports "No open reports" |

`pkg1_apply.sql` is generated by `make_package1.sh` from `0067_apply.sql`, `0072_apply.sql` and the 0073
migration (each with its own start and result check). Tests: `supabase/tests/m3/live_package1.sh` (20/20:
same schema as the three migrations in order, data unchanged, a failure at 0073 undoes 0067 and 0072,
rollback 0073 → 0072 → 0067 restores live's schema exactly).

`pkg3_apply.sql` is generated by `make_package3.sh`: each migration file unchanged, between its own preflight
and postcheck embedded verbatim as guards. Tests: `supabase/tests/m3/live_package3.sh` (18/18: same schema
as the two migrations in order, data unchanged, word list empty, a failure at 0075 undoes 0074, rollback
0075 → 0074 restores every function and the chat policy; 0074's tables and data are kept by design).
Both package tests build their base from `cd5eb3a` (main before the M3 merge = 0001–0071).
