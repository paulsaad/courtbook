# CourtBook — incident runbook (website)

W2a, 22 Nov 2026. For Paul. Short on purpose: what to do when something breaks, in order. No secrets in this file.

## 0. What watches the site

| Signal | Comes as | Means |
| --- | --- | --- |
| A1 New problem | Sentry email | an error never seen before happened on production |
| A2 Regression | Sentry email | an error marked *resolved* happened again |
| A3 Booking or sign-in burst | Sentry email | more than 3 booking or sign-in failures in 1 hour |
| A4 Site down | Sentry uptime email | `/api/health` failed twice in a row: the site or the database is not answering |
| A person | WhatsApp, phone, Help & Feedback | trust it even when Sentry is quiet (ad blockers hide some browser errors) |

Staging and preview errors are recorded in Sentry under their own environment and never send alerts.

What Sentry receives: the error type, a fixed description ("booking: unexpected error"), short codes (database error
code, HTTP status), file / function / line, the page path with IDs replaced (`/bookings/:id`), browser and OS. It never
receives names, emails, phone numbers, sign-in codes, messages from the database, cookies or IP addresses: messages are
withheld (`[withheld]`) unless they are one of our fixed ones. If you ever see personal data in Sentry, that is itself
an incident (step 4, "data exposure").

## 1. Is it real, and how bad?

Open the alert's link in Sentry. Check the **environment** is `production`, then:

| Level | Examples | Act |
| --- | --- | --- |
| **Critical** | no one can sign in or book; bookings wrong or doubled; site down (A4); personal data visible to the wrong person or in Sentry | same day, now |
| **Major** | one area broken: staff calendar, club settings, photos, payments list | same day |
| **Minor** | one odd error, a layout problem | next working session |

Quick checks (read-only, from your phone):

1. Open `https://courtbook-three.vercel.app/api/health` — `{"ok":true}` means the site and the database answer.
2. Open the home page, Play and a club page.
3. Status pages: Vercel (`vercel-status.com`) and Supabase (`status.supabase.com`). If either reports an outage,
   the fix is theirs: tell the club (step 3) and watch.

## 2. Find the cause

- **Sentry issue:** the *release* is the commit that was live; the *path* is the page; tags `area` (booking, auth,
  media, payment, page) and `code` say where and which database error.
- **Did it start with a release?** Compare the first-seen time with the last production deployment in Vercel
  (Deployments). If yes, rollback is the fastest fix (step 4).
- **Vercel runtime logs** (Project → Logs): kept only a short time on Hobby — look early.
- **Reproduce on staging**, never by writing to live data.

## 3. Tell people

For anything critical, tell the pilot club straight away (WhatsApp is fine):

> CourtBook is having a problem with *bookings / sign-in* since *time*. We are fixing it. Until then please take
> bookings by phone. We will tell you when it is back.

When fixed: a one-line "back to normal" message. No technical detail is needed.

## 4. Recover

| Cause | Do |
| --- | --- |
| A code change (release) | Vercel → Deployments → the previous production deployment → **Instant Rollback**. Then the code is reverted on `main` through a normal pull request. |
| Database change (migration) | the migration's own rollback script, after a read-only check of what it would change. |
| Data lost or damaged | restore the verified backup **into a new project** first and compare (`docs/m3/16-live-backup.md`); never overwrite live blindly. |
| A secret leaked | rotate it (W2 plan §8 / OPS-1 procedure), then redeploy. |
| Personal data in Sentry | delete the event or issue in Sentry; fix the filter in `src/lib/monitoring.ts` with a test; note it. |
| Sentry itself too noisy | mute the alert rule in Sentry, or remove `NEXT_PUBLIC_SENTRY_DSN` in Vercel and redeploy: the site runs the same without monitoring. |
| Supabase or Vercel outage | nothing to change; wait, keep the club informed. |

## 5. Check it is healthy again (read-only)

1. `/api/health` answers `{"ok":true}`.
2. Home, Play and a club page load; sign in with an email code and with Google.
3. Staff calendar and club settings open (no saving).
4. Sentry quiet for 30 minutes.

No test bookings on live.

## 6. Write it down

A short note in the CourtBook project: what happened, who was affected and for how long, the cause, the fix, and what
prevents it next time. Mark the Sentry issue *resolved* (A2 tells you if it comes back).

## Accounts involved (names only)

Sentry org `courtbook`, project `courtbook-web` (website) · Vercel project `courtbook` · Supabase live project
(production) and staging project · GitHub repository. Access stays with Paul; credentials are never written here.
