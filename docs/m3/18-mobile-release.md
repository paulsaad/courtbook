# M3 — mobile release 0.3.0 (prepared 21 Nov 2026)

Branch `mobile-release-0.3.0` = `m3-dev` + `release-native-fixes` (`1c8b9b8`, merged cleanly) + the
live game-features switch. Nothing built or published.

## What "release" means today

The live app is **CourtBook** (`app.courtbook.mobile`), built with the `preview` profile: internal
distribution (iOS ad hoc to registered devices, Android APK), channel `preview`, EAS environment
`preview`, **live database**. Store publication (the `production` profile and channel) is M5 and is
blocked on D5 (publisher account), D6 (privacy policy and terms) and the store items below.

## Readiness

| Item | State |
| --- | --- |
| Database | live 0001–0075 (packages 1–3 complete) |
| M3 on phones | staging: Android and iPhone device checks PASS (games, chat, rules, report, block, unblock, Help & Feedback) |
| Live switch | `gameWritesFor` on for staging **and live**; any other database stays off |
| Database wiring | EAS `preview` → `lgujfbwunokobjxlvpuf` (verified by the workflow on 20 Nov; re-checked by every build run before building); the app also refuses a bundle/database mismatch (`lib/variant.ts`) |
| Version | 0.3.0 (runtime 0.3.0; live iOS is 0.2.0, so no 0.2.0 update can reach 0.3.0 or the reverse); build numbers kept by EAS |
| Native config | `check-native-config.sh` all ok: Android declares only INTERNET and VIBRATE, unused permissions blocked; iOS privacy manifest (4 API reasons, no tracking, no data collected); no Face ID text; live/staging isolation |
| Crash reporting | off for the live app (decision 15 Nov); the Sentry library is built in but sends nothing without the DSN |
| Checks on the branch | typecheck; 538/538 unit tests (also as a live bundle); shared copies; release bundling iOS + Android |
| Signing | iOS: ad hoc credentials exist (0.2.0). Android: no live build yet — the workflow checks the keystore before building and stops if there is none |

## Release steps

1. Approve the branch contents.
2. Mobile build workflow from `mobile-release-0.3.0`: app live, Android; then app live, iOS.
3. Install from the build pages (Android APK link; iPhone install page, registered device).
4. Live phone check — **read only** (no M3 writes on live): Profile → About shows 0.3.0 and the
   built-in update; sign in (email code); Find a game loads; an existing game opens; Profile → Help &
   Feedback opens; bookings list loads.
5. Merge `mobile-release-0.3.0` into `m3-dev` and `main` (mobile and docs only).
6. Later changes: over-the-air updates on `preview`, fingerprint-checked.

## Not in this release (store submission, M5)

Publisher account and app name (D5); privacy policy and terms (D6); Apple privacy labels and Google
Data safety; listings, screenshots; reviewer demo account; moderator review frequency; 180-day report
text clearing; independent VoiceOver / TalkBack check; Play closed test (12 testers, 14 days) if the
Play account is personal.
