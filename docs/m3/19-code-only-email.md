# Code-only email sign-in (approved 21 Nov 2026 — templates final; live not yet changed)

**Goal:** one experience on website, Android and iPhone: receive a code, type it, signed in. No links.

## Why the link failed

The link and the code are the same one-time token. Tapping the link uses it up — so the code is then
"expired" — and the link cannot finish a sign-in that the app started (the app asks with no return
address, so Supabase sends the link to the website, which does not hold the app's half of the
exchange). It can never work for an app-started sign-in.

## Where the email comes from

Email templates are a **per-project** Supabase setting (Authentication → Emails → Templates), shared
by every client of that project: the website and both live apps all receive the **live** templates.
Two templates are used by code sign-in, and both must change:

| Template | Sent when |
| --- | --- |
| **Magic Link** | an existing account asks for a code |
| **Confirm signup** | the first sign-in of a new email (the account is created) |

Not used by CourtBook (no change): Invite user, Change email, Reset password, Reauthentication.
Staging already sends code-only Magic Link and Confirm signup emails (set 17–18 Nov); live still has
code + link.

## Code-only support today

| Platform | Code entry | Depends on the link? |
| --- | --- | --- |
| Website (`main`) | `verifyOtp(type email)`, 6–10 digits | No. Its wording mentions the link and it passes `emailRedirectTo` (unused once the link is gone) — branch `web-code-only-signin` `9b8287f` removes both. |
| Android 0.3.0 + update `01a1fe1d…` | 6–10 digits, verified on your Galaxy | No. Wording mentions the link — fixed on `mobile-signin-code-fix`. |
| iPhone 0.3.0 + update `01a1fe1c…` | same code as Android | No. Same wording fix. |

Google and Apple sign-in do not use these emails; `/auth/callback` stays for Google.

## Proposed templates

Files: `docs/m3/email/magic-link.html`, `docs/m3/email/confirm-signup.html`. Variables used:
`{{ .Token }}` and `{{ .Email }}` only — no `{{ .ConfirmationURL }}`, `{{ .TokenHash }}`,
`{{ .SiteURL }}` or `{{ .RedirectTo }}`, not even in a comment (Supabase fills those in anywhere).
Expiry "1 hour" = live's Email OTP Expiration (3600 s, confirmed by Paul 21 Nov; OTP length 8, custom SMTP on).

| Template | Subject |
| --- | --- |
| Magic Link | Your CourtBook sign-in code |
| Confirm signup | Welcome to CourtBook — your sign-in code |

## Before changing live (read only)

In Supabase → live project → Authentication:
1. Sign In / Providers → Email: **Email OTP Expiration** (seconds) → gives EXPIRY; **Email OTP Length** (expect 8).
2. Emails → SMTP Settings: whether custom SMTP is on (on a free project, template edits need it; live's
   current email already carries a code, so its templates were edited before).

## Rollout (after approval)

1. Paste the two templates into live (Magic Link, Confirm signup), with EXPIRY filled in. Save.
2. Request a code on the website; the email must show the code only. Sign in with it.
3. Publish the app wording update (JavaScript only, fingerprint unchanged) and merge
   `web-code-only-signin` into `main` (website wording).
4. Sign in once on each phone with a fresh code.

Undo: paste the previous template text back (copy it before step 1).

## Done (21 Nov 2026)

- **Live templates: VERIFIED.** Magic Link and Confirm signup replaced by Paul (previous text kept by
  him for rollback); production website email shows the 8-digit code and "1 hour", no link; code
  sign-in works.
- **Website wording:** `main` fast-forwarded to `9b8287f` (one file, `LoginForm.tsx`); Vercel
  production deployment succeeded.
- **App wording** (run 44907853205 from `d913f32`; live database; 545/545 tests; fingerprints matched
  the 0.3.0 builds): iOS update `01a1fe40-6a33-7ac3-a554-e7ed935eac86` (group
  `9b2260c7-4d75-4920-9341-5cabf47e9967`), Android update `01a1fe41-1af3-71e4-8d9e-0b742881ef3c`
  (group `5160d955-72aa-4697-a66c-902c908a15cf`). Previous groups for rollback: iOS `89fb8488…`,
  Android `ebc2b01a…`.
