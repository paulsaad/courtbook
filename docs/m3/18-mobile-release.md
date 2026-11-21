# M3 — mobile release 0.3.0 (released to registered devices 21 Nov 2026)

Branch `mobile-release-0.3.0` = `m3-dev` + `release-native-fixes` (`1c8b9b8`, merged cleanly) + the
live game-features switch, then the sign-in and Bookings-status fixes (sections below). **Status:**
both live 0.3.0 builds made and installed; Android and iPhone read-only checks PASS; merged into
`m3-dev` and `main`. Not in any store.

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
| Version | 0.3.0 (runtime 0.3.0) installed on Paul's iPhone and Galaxy A17 (the iPhone's earlier 0.2.0 build is replaced; 0.2.0 updates cannot reach 0.3.0 or the reverse); build numbers kept by EAS |
| Native config | `check-native-config.sh` all ok: Android declares only INTERNET and VIBRATE, unused permissions blocked; iOS privacy manifest (4 API reasons, no tracking, no data collected); no Face ID text; live/staging isolation |
| Crash reporting | off for the live app (decision 15 Nov); the Sentry library is built in but sends nothing without the DSN |
| Checks on the branch | typecheck; 538/538 unit tests (also as a live bundle); shared copies; release bundling iOS + Android |
| Signing | iOS: ad hoc certificate and profile valid to 13 Nov 2027 (2 devices). Android: keystore "Build Credentials 12pYrq-bTC" created by Paul 21 Nov (default for `app.courtbook.mobile`) |

## Release steps (all done 21 Nov 2026)

Builds from `d7629ba`: Android run 44900766606 (build `721cd144-7869-4bcf-991b-f362c32a8503`), iOS run
44899732537 (build `05d7f527-4b06-4fb1-8f8c-294f0aa325d4`).


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

## Blocker found in the live phone check (21 Nov 2026) — release merge stopped

**Email sign-in fails on 0.3.0 against live.** The live project sends 8-digit codes; the app's code
field has stopped at 6 digits since the proof of concept (13 Nov). The website accepts 6–10 and so
never showed it. Staging was set to 6 digits on 17 Nov (Galaxy sign-in work), which hid the mismatch
from every staging test. The email's "Sign in" link goes to the live Site URL (the website), because
the app does not ask for a return to the app; it signs in the phone's browser, never the app.

Fix (branch `mobile-signin-code-fix`, `d085557`, not published): the app accepts 6–10 digits like the
website, strips spaces from a pasted code, sends the whole code, and says to type the code because the
link opens the website. Regression tests `__tests__/signInCode.test.tsx` (7; the old 6-digit limit
fails one). JavaScript only — native fingerprint identical to the installed 0.3.0 builds (android
`242979cd`, ios `de2d475b`) — so it ships as an update on the `preview` channel, no new build.

**Published 21 Nov 2026** (approved), run 44904680261 from `0d14725`: database `lgujfbwunokobjxlvpuf`,
545/545 tests, fingerprints matched one 0.3.0 preview build each. iOS update
`01a1fe1c-f049-7e88-b525-21d661e5e200` (group `89fb8488-5f7a-4f05-a59d-9173d5a63c42`); Android update
`01a1fe1d-aeb2-7959-8cde-0db4b5b7c79e` (group `ebc2b01a-0588-408b-b15c-7ff4cebb88f5`), runtime 0.3.0.
Undo: Mobile update → rollback-to-built-in, app live.

### Regression prevention: staging and live auth settings must match

The fault came from a staging setting that differed from live (Email OTP length 6 on staging, 8 on
live), so every staging sign-in test passed while live could not sign in. Kept from now on:

1. **The app never depends on one project's setting:** it accepts the whole 6–10 range Supabase
   allows, as the website does (`lib/otpCode.ts`, tested).
2. **Auth parity list:** staging mirrors live for Email OTP length, OTP expiry, email templates (code
   and link), Site URL and Redirect URLs (`courtbook://auth-callback`). Any change to one project's
   auth settings is made on both, or recorded here as a deliberate difference. Known difference today:
   OTP length (staging 6, live 8) — proposal: set staging to 8 (staging only, needs approval).
3. **Every release includes one real sign-in on live** with the installed build before merge — the
   check that found this.
4. Later, if a read-only Supabase management token is ever approved: an automated comparison of the
   two projects' auth settings in the release checklist.

## Bookings status update (21 Nov 2026)

Approved design `cc45baf` (status in colour and words; cancelled = danger red, never brand red).
Published, run 44909064418: live database, 559/559 tests, fingerprints matched the 0.3.0 builds.
iOS `01a1fe4d-80b9-7eb0-9452-22a356700fd8` (group `da534117-7792-4a48-a3eb-22ff821eb2bb`), Android
`01a1fe4e-2130-7721-99f1-f63dcd61a22f` (group `3329bbfb-fdb3-4947-993d-59f321c97afd`). Previous groups:
iOS `9b2260c7…`, Android `5160d955…`.

**Follow-up (non-blocking): unknown statuses.** `my_agenda` today returns bookings only as confirmed,
cancelled or no_show, and games as open, closed or cancelled with role organizer, accepted or
pending, so every real row maps correctly. But the fallbacks are optimistic: any other upcoming
booking status (e.g. `pending` or `expired`, if the query ever includes them) or any other game role
would show green "Confirmed" / "You're in". Proposed: green only for exactly `confirmed` and roles
`accepted` / `organizer`; anything else neutral with "See details", plus tests for each unknown case.

## Unknown-status fallback (21 Nov 2026)

`2f7e8b4`: green only for a confirmed booking or a game you are accepted in or organise; any other
status or role neutral "See details" (8 tests). Merged; published from `main` `af4c95e`, run
44911516249: iOS `01a1fe69-33d3-7615-948d-c7de6efd64e7` (group `7914192f…`), Android
`01a1fe69-f32f-7b9a-9a58-3d27df464cc0` (group `af01a96a…`). Previous groups: iOS `da534117…`, Android
`3329bbfb…`. M3 closed: `20-m3-closure.md`.
