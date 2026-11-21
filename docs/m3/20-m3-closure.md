# M3 — COMPLETE, scope frozen (21 Nov 2026)

M3 = Find a game, game screen, joining and organiser actions, Post / Edit a game, chat, Activity, player
safety (report, block, rules, suspension, moderation), Help & Feedback; plus the release fixes 0068–0071,
code-only email sign-in and the Bookings status display. **Scope is frozen:** anything further is a new,
separately approved item (roadmap phase I for the desktop website; M5 for store submission).

## Final state

| Part | State |
| --- | --- |
| Live database | 0001–0075 (release fixes and packages 1–3, each with read-only checks before and after) |
| Website | production = `main` `af4c95e`; Vercel production deployment succeeded |
| Branches | `main` = `m3-dev` = `af4c95e` |
| Android | CourtBook 0.3.0 build `721cd144…` on Paul's Galaxy A17; checks PASS |
| iPhone | CourtBook 0.3.0 build `05d7f527…`; checks PASS |
| Latest update (both) | run 44911516249 from `af4c95e`: iOS `01a1fe69-33d3-7615-948d-c7de6efd64e7` (group `7914192f-ab18-4568-a714-2e53cd0c4368`), Android `01a1fe69-f32f-7b9a-9a58-3d27df464cc0` (group `af01a96a-1ef0-4806-a36c-27d106415918`) |
| Sign-in email | live Magic Link and Confirm signup: code only, 8 digits, 1 hour (verified) |
| Checks on `af4c95e` | website typecheck, 147/147; app typecheck, 567/567; shared copies; release bundling iOS + Android; native fingerprints unchanged (android `242979cd`, ios `de2d475b`) |
| Stores | not submitted (M5) |

## Operational clean-up checklist (separate from M3 scope)

| # | Item | Who | Note |
| --- | --- | --- | --- |
| 1 | Reject the waiting live backup run #13 (Actions → run → Review deployments → Reject) | Paul | started before #12 was confirmed; must not be approved by mistake |
| 2 | Remove the live database credential: delete `LIVE_DB_URL` from the `live-backup` environment, or reset the database password | Paul | deployment is complete; keep backup #12 (two copies) and its passphrase |
| 3 | Staging Email OTP length 6 → 8, to match live (auth parity) | approval, then Paul or me | staging setting only |
| 4 | New staging native builds (Android, iOS) before the next staging update | approval | the native fixes changed the fingerprint; the staging app keeps its current update until then |
| 5 | Delete finished branches: `mobile-release-0.3.0`, `mobile-signin-code-fix`, `mobile-bookings-status`, `web-code-only-signin`, `release-native-fixes`, `db-backup-staging`, `staging-tester-check`, `staging-otp-check`, `staging-auth-templates` | Paul (the session cannot delete branches) | all merged or obsolete |
| 6 | Duplicate staging account `966f79cf` | open question | `12-staging-duplicate-account.md` |
| 7 | GitHub Support: purge commit `07ff5bb` (staging password fragment) | Paul | from 18 Nov |

## Next (each needs its own approval)

M5 store submission (publisher account D5, privacy policy and terms D6, store labels and listings,
reviewer account, moderator review frequency, 180-day report-text clearing, independent accessibility
check); roadmap phase I (responsive desktop website).
