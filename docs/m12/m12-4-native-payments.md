# M12.4 — paying the CourtBook booking fee in the Android app

Status: implemented on branch `m12-4-native-payments` (draft PR, based on `m12-1-fee-online`). **Not deployed, not
activated, never run against staging or production.** Real mobile payments are **not** proven: there is no real
provider (Whish is a stub), and nothing has run on a phone.

## 1. What it does

| Club | App behaviour |
| --- | --- |
| `at_desk` | Unchanged: confirmed at once, pay at the club |
| `fee_online`, fee > 0, **feature on** | Reserve → 10-minute hold → payment screen → pay the fee on the provider's page → the server confirms → "Court booked" |
| `fee_online`, fee $0, **feature on** | Confirmed at once, no payment screen (hold_slot does this, 0093) |
| `fee_online`, **feature off** (every distributed build today) | Unchanged: "Reserve on the website for now" |
| `simulated` (Model 1 demo), unknown modes | Unchanged: website |

"Court booked" appears only for a booking the database has confirmed. A pending hold goes to the payment screen.

## 2. Server (website project)

| Path | Who | What |
| --- | --- | --- |
| `POST /api/native/pay/start` `{paymentId, requestKey}` | `Authorization: Bearer <Supabase access token>` | Same engine as the website's `/api/pay/start` (`src/lib/payments/startFlow.ts`). Answers `{redirect}` / `{attempt,outcome}` / `{attempt,state}` / `{error,final}` |
| `POST /api/native/pay/status` `{paymentId}` | same | Asks the provider about an unresolved attempt, then returns `state` (confirmed, awaiting_payment, payment_open, checking, hold_expired, refund_due, cancelled), attempts left, refunds due. Never starts or retries |
| `GET /pay/app-return` | anyone | Static. Reads and records nothing; links to `PAYMENT_APP_SCHEME://payment-return` |

- The token is checked with Supabase Auth (`auth.getUser(token)`). The database client then acts as that player (RLS,
  `auth.uid()`). `start_payment_attempt` refuses another player's payment (`not_found`). `status` reads only rows with
  `profile_id` = the token's user, because club staff and admins can *read* other people's payments under RLS.
- The website route is now a thin cookie-auth wrapper over the same engine. Its 29 existing tests pass unchanged.
- Return URL given to the provider: `${PAYMENT_SITE_URL}/pay/app-return`. It carries no token, payment or attempt.

**New server variables** (none set anywhere):

| Variable | Meaning |
| --- | --- |
| `NATIVE_PAYMENTS=1` | Turns both native endpoints on. Anything else → 503 |
| `PAYMENT_APP_SCHEME` | `courtbook` (live) or `courtbook-staging`; anything else → no app link on the return page |

**Database:** nothing new. Needs 0093 (M12.1). 0094 (M12.2) is not needed.

## 3. App

| File | Role |
| --- | --- |
| `lib/feePayment.ts` | Pure rules: feature switch and server per app, reading answers, key keep/drop, screen text, booking-screen fee line |
| `lib/payController.ts` | Request key per account (SecureStore, written **before** sending), start/check, double-tap guard |
| `lib/payments.ts` | Device wiring: token from the Supabase session in the header only, 20 s timeout = unknown |
| `app/pay/[id].tsx` | Payment screen |
| `app/payment-return.tsx` | Deep link target when the app was not waiting; opens this account's payment |
| `app/club/[id].tsx`, `lib/reserveButton.ts` | fee_online reservable when on; a live hold blocks reserving elsewhere |
| `app/booking/[id].tsx`, `lib/bookings.ts` | Model 2 fee lines and cancellation wording; nothing about money before the payment row is read |

**App switch:** `EXPO_PUBLIC_FEE_PAYMENTS=1` at build time. Not set in any EAS environment, so the feature is off.
The server is fixed per bundle id. Configuration cannot redirect an app to the other environment:
- live app → `https://courtbook-three.vercel.app`;
- staging app → `https://courtbook-staging-git-staging-web-paul-bc50.vercel.app`.

No new permission, plugin, store id, channel, signing or build setting. `expo-web-browser` and `expo-linking` were
already installed.

## 4. Recovery rules (C1–C3)

- **One request key per unresolved tap.** It is stored per account before sending. The same key always returns the
  same attempt (0093), so a double tap, a lost answer or a tap after the app was killed cannot start a second payment.
- **When the key is dropped:**
  - after a start answer: the attempt finished, failed or expired, or the refusal was final;
  - after a status answer: the server reports no unresolved attempt.
- **Nothing is ever sent again on its own.** An unknown outcome shows "Check payment" (a read). Pay with the stored
  key can only find the same attempt.
- **When the server is asked:** after the browser closes (however it closed), on return to the app, on reopening, on
  reconnect while checking, and on "Check payment". A redirect or deep link is never treated as proof.
- **Release:** shown only while awaiting payment; never while a page is open or the outcome is unknown.
- **Account switch:** another account sees nothing. Storage is keyed by user id, and the server answers only the
  token's own payments.
- **M12.1 rules unchanged:** max 3 attempts; one unresolved attempt at a time; failures keep the hold; the deadline is
  never extended; no attempt after expiry.

## 5. Tests

| Suite | Count | Where |
| --- | --- | --- |
| Native routes (mocked DB/provider) | 17 | `src/app/api/native/pay/nativeRoutes.test.ts` |
| App return, switch | 3 | `src/lib/payments/appReturn.test.ts` |
| Whish stub refusal (H2) | 2 | `src/lib/payments/whish.test.ts` |
| **Real database, real routes** (local PostgREST; fake gateway; fake Auth token check) | 33 | `supabase/tests/api/native.mjs` (`SCRIPT=native.mjs bash supabase/tests/api/journey.sh`) |
| App rules and recovery | 36 | `mobile/__tests__/feePayment.test.ts` |
| Payment screen | 6 | `mobile/__tests__/payScreen.test.tsx` |

Regression on this branch:
- **Website:** vitest all pass.
- **Mobile:** jest all pass.
- **Local Postgres suite:** run.sh 381.
- **fee_online:** 60 checks, 19/19 mutants.
- **Races:** FEE=1 126; simulated 82.
- **API:** journey 71; security 34.

Mutation checks on the new server code (each caught, then restored):
- dropping the `profile_id` filter → N20 fails (staff could inspect);
- trusting the token without asking Auth → N23 fails (forged token accepted).

## 6. Decisions needed (not taken)

1. **Staging access (blocks phone testing).** The `courtbook-staging` project has Vercel Authentication on all
   deployments. The app cannot send a Vercel bypass secret: it would be extractable from the APK. Options:
   - (a) a Deployment Protection exception for the `staging-web` alias, which makes staging's website public (staging
     data only, every page still needs a CourtBook sign-in);
   - (b) host only the two native endpoints elsewhere, for example a Supabase Edge Function (new code path; more
     work);
   - (c) test native payments only against the live project once real payments are approved (not recommended).

   **Recommendation: (a)**, for the staging project only, after the 72-hour trial.
2. **The staging alias** in `PAYMENT_SERVER.staging` follows Vercel's branch-address pattern. Confirm it in the Vercel
   dashboard before the first staging build with the feature on.
3. **Whish:**
   - Does it accept an https return URL with no query?
   - Does it redirect inside a Custom Tab?
   - Unknown-reference behaviour, transaction list, retention and delay (already open from M12.2).

## 7. H1 — phone checklist (Galaxy A17; for Paul, when §6.1 is resolved)

Preconditions (developer, each separately approved):
- 0093 on staging (PR #35 procedure);
- the staging website built from this branch with `NATIVE_PAYMENTS=1`, `PAYMENT_APP_SCHEME=courtbook-staging`,
  `PAYMENT_SITE_URL` set to the staging address, and `PAYMENT_PROVIDER` unset (simulated);
- a demo club set to `fee_online` with fee $1;
- a staging app build with `EXPO_PUBLIC_FEE_PAYMENTS=1`.

| # | Do | You should see |
| --- | --- | --- |
| 1 | Open the demo club, pick a time | "Reserve and pay fee"; the panel says the court is paid at the club and the fee online, with the refund sentence |
| 2 | Tap Reserve and pay fee | The payment screen: club, court, time, court price "Pay at the club", fee "Pay online now", a countdown, the exact sentence "The CourtBook booking fee is not refunded if you cancel. It is refunded if the club cancels or your booking cannot be confirmed.", and "Test mode…" |
| 3 | Tap Pay booking fee twice quickly | One payment only; then "Court booked" with "Booking fee paid. Pay $X at the club." |
| 4 | Bookings tab | The booking is Confirmed |
| 5 | New hold; leave the app for 1 minute; come back | Still the payment screen, countdown continued |
| 6 | New hold; swipe the app away; reopen; open Bookings → the booking → Pay booking fee | The same hold; nothing was charged |
| 7 | New hold; airplane mode; tap Pay | "You're offline, so nothing was sent." |
| 8 | New hold; wait 10 minutes | "Your hold time is up" → Check payment → "Hold ended… No fee was taken." |
| 9 | New hold; try to reserve another court at any club | "Finish your held booking first", disabled; "Go to held booking" |
| 10 | New hold; Release this court → Release | Back to Courts; the time is free again |
| 11 | A confirmed fee booking → Cancel booking | The message says the $1 fee is not refunded when you cancel |
| 12 | Largest text size (Settings → Display → Font size) | Everything on the payment screen readable; buttons not cut off |
| 13 | TalkBack on: the payment screen | Title, countdown, prices and buttons are read in order |
| 14 | Sign out; sign in as another account; open Bookings | None of the first account's holds or payments |

Not testable until a real provider exists: the hosted page, a real return, a lost callback with real money, refunds.

## 8. H2 — provider-activation safety audit

What has to be true for **real money** to move from the app (all of them, each a deliberate act):
1. A real adapter: `whish.ts` is a stub that cannot reach Whish.
2. `PAYMENT_PROVIDER=whish` on the deployment.
3. The DB setting `app.payment_provider='whish'`. Without it, `hold_slot` refuses a fee at a real club
   (`payments_not_configured`), and `set_club_payment_mode` refuses `fee_online` at a real club.
4. The club set to `fee_online` with a fee.
5. `NATIVE_PAYMENTS=1` and `PAYMENT_SITE_URL` on the server.
6. An app build with `EXPO_PUBLIC_FEE_PAYMENTS=1`.

Findings:
- **Fixed:** the Whish stub's `startAttempt` threw a plain error, which the engine rightly treats as "outcome
  unknown". With `PAYMENT_PROVIDER=whish` set by mistake, every attempt would have stayed `starting` until the hold
  ended, and the player could not try again. It now throws `PaymentStartRefused`, a definite refusal: nothing was sent.
  No money risk either way.
- Adding any single variable cannot cause a real charge (items 1 and 3 are independent of every variable).
- The simulated provider is accepted only at demo clubs (0093 `hold_slot`). Its success is recorded with
  `collected=false`. The app labels it "Test mode".
- No Whish endpoint, field or behaviour was invented. The adapter remains unwritten until Whish confirms the open
  questions in `whish.ts`.

## 9. H3 — security and privacy review

| Area | Result |
| --- | --- |
| Authentication | Bearer token only; strict `Bearer <jwt>` shape; checked by Supabase Auth on every call. Forged, expired, anon-key, service-role-key and deleted-user tokens → 401 (N23) |
| Authorisation | Start: the DB refuses another player's payment. Status: `profile_id` must match; staff and admins get 404 (N18–N20). Responses for "not yours" and "does not exist" are identical (N19) |
| Confirmation | Only the server, with the service role, after the provider's answer. Players (even the owner) cannot call the recording functions (N21) |
| Tokens | Never in URLs, deep links, the return page, provider input, reports or logs (N2, N27, vitest) |
| Secrets in the app | None. A jest test scans app code for service-role, cron and provider credentials |
| Open redirect | The app opens only https pages from the server's answer; the server checks too. The return page links only to the two app schemes |
| Caching | Native responses are `Cache-Control: no-store` |
| Privacy | The status answer carries no names, phone numbers, provider references or page links; charges are counted, not listed |
| Remaining risk | `/pay/app-return` is public by design (static). The status endpoint asks the provider on every call for an unresolved attempt; there is no per-player rate limit (same as the website's return page). Consider one before live |
