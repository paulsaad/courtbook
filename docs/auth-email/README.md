# Silent staging sign-in-email failure — local investigation (26 Nov)

Follows "staging email-delivery discrepancy (25 Nov, read-only investigation)" (project doc). Constraints kept: no
email sent, no SMTP or Auth setting changed, no staging action. Local tests and existing evidence only.

## What happened (unchanged)

24 Nov 19:18:48Z: the staging app asked Supabase Auth for a code for a new address. Auth created account `1ddfb189`,
logged `user_confirmation_requested`, answered **200**, and no email left staging's SMTP (Paul's Gmail has no Sent
copy). Only Auth's **background sending** mode produces "account created + 200 + no mail": in its default (sync) mode
an SMTP failure is the request's answer (500) and the account is rolled back.

## New evidence (26 Nov)

| Source | Finding |
| --- | --- |
| Gmail (read-only search, `"CourtBook Staging"` since 24 Nov, all folders) | One message: the 24 Nov **11:09:02Z** code (time decoded from its message id). Nothing since: no later staging send has been attempted or none succeeded. No new evidence either way. |
| Supabase Auth logs | Not accessible from here; the 24 Nov entries have expired (about one day kept). |
| Our Sentry | By design receives nothing for this case (below). |

## Local reproduction: what our clients can know

`src/app/login/emailSendModes.test.tsx`: the real sign-in page and the real `@supabase/auth-js` 2.119 against a local
stand-in for Auth's `POST /otp`, the SMTP send failing in both modes.

| Auth sending mode | What Auth answers | Website shows | Reaches our Sentry | App shows | App reports |
| --- | --- | --- | --- | --- | --- |
| **Background** (matches 24 Nov) | 200 at once; failure only in Auth's own log (`apitask: error running "mailer.…"`) | "Email sent to …" | **No** | the code screen | No |
| Sync (Auth's default) | 500 "Error sending confirmation email" | **before this fix: "Couldn't reach CourtBook. Check your connection and try again."** — now: "We couldn't send the code just now. Try again in a minute." | Yes (`authCodeSend`, status 500) | same text (shared) | **No** (the app has no message reporting) |

**Conclusions**

1. In background mode **no client can detect the failure**: the 200 comes before the send. The only record is Auth's
   log. The "silent" part is structural, not a bug in our code. Detection must be server-side: an alert on Auth
   `apitask`/mailer errors (dashboard log drain or Supabase's log alerts), plus the delivery check below.
2. **Defect found and fixed here (draft):** `@supabase/auth-js` 2.119 names every 5xx answer (500–530)
   `AuthRetryableFetchError`, and our shared `authText` treated that name as "offline". A genuine mail failure in sync
   mode therefore told the person to check their connection. `src/lib/authText.ts` (copied to `mobile/shared/`) now
   treats 5xx as the server's failure: "We couldn't send the code just now…" when sending, "Something went wrong on our
   side…" when checking. Existing wording only. No status (0) is still "offline". The previous tests used 5xx shapes
   without that name, which is why it was missed; tests with the real shapes added.
3. The website says "Email sent to …" on a 200, which is a request accepted, not a delivery. Wording proposal below
   (needs Paul's approval; not changed).
4. The app reports no sign-in failure to Sentry at all (the website reports 5xx). Adding it touches the reviewed crash
   privacy filter (`mobile/lib/crash.ts`, fixed-message allowlist): proposal, not built.
5. Related: the app and website call `signInWithOtp` without `shouldCreateUser: false`, so a mistyped address creates
   an account. That is how `1ddfb189` appeared. Unchanged here; it is a product decision (sign-up by code is intended).

## What would decide the staging cause (each needs Paul's approval; none done)

Unchanged from the 25 Nov document, after the trial evaluation (27 Nov 17:55Z): read-only screenshots of staging SMTP
settings and the Gmail app-password list; then one code request for **Paul's existing tester address** with Gmail Sent
and Auth logs checked within two minutes. A failed Gmail login (revoked app password) is the most likely cause.

## Proposals (not implemented)

| # | Change | Kind |
| --- | --- | --- |
| E1 | Alert on Auth `apitask`/mailer errors, staging and production | Supabase dashboard configuration |
| E2 | Code-screen wording: "We've asked for a code to be emailed to {email}. It usually arrives within a minute; check Spam. Nothing after 2 minutes? Resend, or sign in with Google." | Copy, website and app |
| E3 | App: report a 5xx sign-in failure (fixed message, no address), like the website's `authCodeSend` | Privacy-reviewed code |
| E4 | Production mail from a proper sender, not a personal Gmail (M5, L10) | Already on the launch list |
