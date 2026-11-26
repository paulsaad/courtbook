# Android pilot builds: process and exact prerequisites (draft, 26 Nov)

Nothing here builds, uploads or distributes anything. Every build run and every Play upload needs Paul's go.

## Two builds, in this order

| | Staging app (acceptance on the Galaxy A17) | Pilot app (Google Play closed testing) |
| --- | --- | --- |
| Workflow input | `Mobile build (Expo)`: app **staging**, platform android | app **pilot**, platform android (new in this PR) |
| Branch ("Use workflow from") | `int/pilot-26nov-staging` | `int/pilot-26nov-staging` (it carries #50's artwork gate; see "Branches" below) |
| Name / package | CourtBook Staging / `app.courtbook.mobile.staging` | CourtBook / `app.courtbook.mobile` (permanent once on Play) |
| Database | staging (`pwznauyioqykdwodwpvx`) | live (`lgujfbwunokobjxlvpuf`) |
| EAS profile → file | `staging` → APK, internal install page | `pilot` → **app bundle (.aab)**, store distribution |
| EAS environment / update channel | development / `staging` | **production / `pilot`** (separate from the test phones' `preview`) |
| Crash reporting | on if the `SENTRY_DSN` secret exists | **off** (L11 not yet decided; the DSN is removed) |
| Artwork gate | STG artwork, approved 25 Nov: **passes today** | live artwork: **refused today** (`not_approved`, exit 1) |
| Legal-pages gate | warning only | must pass (passes while the app links no legal page) |
| Delivered as | install page with a QR code | download the .aab from expo.dev; **upload by hand** in Play Console |

Version for both: **0.4.0** (#59), runtime 0.4.0, Android version code from EAS's remote counter (auto-increment on
`pilot`). Target API **36** (Expo SDK 58 / React Native 0.88 default; compile SDK 37), which meets Google Play's rule for
new apps and updates from 31 Aug 2026.

## What the workflow checks before spending a build (unchanged, now also for `pilot`)

1. `EXPO_TOKEN` exists.
2. The EAS environment's database is the right one for the app (`eas-app-env.sh` reads the settings back; a mismatch
   stops the run). Tested locally with a stand-in `eas`: `bash .github/scripts/eas-app-env.test.sh` → 11/11; a pilot
   pointed at staging, or a pilot with only the test-phone environment set, is refused.
3. Signing credentials for the package are in EAS (read only).
4. App type-check, unit tests, release bundling for iOS and Android.
5. Legal-pages gate, artwork gate.

## Exact remaining prerequisites

**Staging app (Galaxy A17 acceptance):**
- S-1. The deletion trial's final evaluation (27 Nov), then staging 0087–0092 and 0093 applied, each with Paul's go. The
  app calls six functions from 0087–0088 (favourites, saved areas; checked against the migrations); on today's
  staging (0086) those screens would fail.
- S-2. Secrets present: `EXPO_TOKEN`, `STAGING_SUPABASE_URL`, `STAGING_ANON_KEY` (and `SENTRY_DSN` if crash reports are
  wanted). Not verifiable from here; the workflow's first steps say which is missing.
- S-3. An Android keystore for `app.courtbook.mobile.staging` in EAS. The read-only step lists it; if there is none, Paul
  creates it once with `eas credentials` (the workflow runs non-interactively and cannot create one).
- S-4. Paul's go for the run. Then install from the QR page on the A17 and run the M11 checks.

**Pilot app (Google Play closed testing), in addition:**
- P-1. **Branding decision (L18 / B1)**: final icon and splash files, then their entry in
  `mobile/assets/artwork-approvals.json`. The gate refuses the live app until then.
- P-2. **Publisher entity and Google Play Console account (L1, L5 / B2)**, then the app created in Play Console with
  package `app.courtbook.mobile`, Play App Signing on (Google keeps the app signing key; the EAS keystore becomes the
  upload key), a closed-testing track and its tester list.
- P-3. **Play's store-side forms:** a public privacy-policy URL (live `/privacy` is a 404 today: B3, LI-1), the Data
  safety form (drafts in `docs/m5/store-package.md`; approximate foreground location stays on the phone, the
  installation ID, account deletion), the content-rating questionnaire, target audience 18+, app access for the
  reviewer (a player-only test account), ads: none.
- P-4. **Live database rolled forward** to 0093, with the live switches (demo club hidden, 18+ enforced) and the
  deletion-retry worker running on live before the deletion screens reach players (B4, M2 rollout order).
- P-5. **EAS `production` environment**: `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` for the live
  project (the publishable key after the B6/M3 key steps). The run refuses until the URL is the live project's.
- P-6. An Android keystore for `app.courtbook.mobile` in EAS (as S-3).
- P-7. Pilot clubs set up on live with exact map points and desk accounts (B7); pilot configuration check (#52) on
  live, with its own go.
- P-8. Merge of this PR's workflow change (Paul's approval). Until then the workflow offers only live (APK) and staging.
- P-9. Paul's go for the build, then for the upload. **The first release of a new app is uploaded by hand** in Play
  Console (Google's API cannot create it); this workflow never sends anything to Google.

**After the upload:** testers opt in through the closed-testing link. Updates without a new build go to channel `pilot`
(`Mobile update (Expo)`, app **pilot**); they never reach the test phones on `preview`, and the reverse.

## Branches

The artwork gate and the STG files come from #50, which is in `int/pilot-26nov-staging` but not in `int/pilot-26nov`.
Every store-bound build must pass that gate, so builds run from `int/pilot-26nov-staging`. The two lines differ only by
#50's files (checked). Once #50 is approved for merge, folding it into `int/pilot-26nov` removes the distinction.

The staging **website** is a different build (WP, `docs/ops/staging-0087-0092-sequence.md` §2b): never deploy
`int/pilot-26nov-staging` to `staging-web`, which would drop the deletion schedule.
