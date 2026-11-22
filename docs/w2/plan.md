# W2 — Monitoring and operational readiness (plan for review)

**Status: approved by Paul 22 Nov 2026 with two review corrections (privacy: no free text; test endpoint staging-only), now in §3, §9. W2b deferred; OPS-1 after W2a, before real users; Vercel Hobby until a commercial pilot.** Base: production `main` = `26d6244` (W1
released and closed). This plan supersedes Part 3 of the website completion plan.

W2 is split so the launch-critical part stays small:

| Part | Contents | Launch-critical | Database change | New secrets / accounts | Cost |
| --- | --- | --- | --- | --- | --- |
| **W2a** | website error monitoring (Sentry), privacy scrubbing, alerts, health check + uptime monitor, operations runbook | **yes** | none | Sentry project; DSN (public); optional upload token | $0 |
| **W2b** | game and chat notification emails made reliable | only if the pilot needs them (decision) | yes (one trigger, separate approval) | sender mailbox + app password; webhook secret | $0 |
| **OPS-1** | delete 246 old live-connected previews; rotate the live service key | before real users | none | none new | $0 |

## 1. What exists today (verified in code and configuration)

| Area | Today |
| --- | --- |
| Website errors | No monitoring. `src/app/error.tsx` / `global-error.tsx` show "Couldn't load" with Try again but report nothing. Server errors only reach Vercel runtime logs (Hobby plan: short retention). Five `console.error` calls (4 in `api/club-media`, 1 in `api/pay/simulate`). |
| Mobile app errors | Sentry org **`courtbook`**, project `react-native`; `mobile/lib/crash.ts` with tested scrubbing (no user, IP, taps, bodies, headers, query strings; emails masked). Verified on staging; **off in the live app** until Paul approves. Upload-only org token exists as GitHub secret `SENTRY_AUTH_TOKEN`. |
| Expected refusals | Shown via `friendlyError()` (`src/lib/types.ts`, byte-shared with the app) — e.g. "just taken". Unknown errors show "Something went wrong. Refresh and try again." and are invisible to us. |
| Health check / uptime | None. |
| Rollback | Vercel Instant Rollback (used in W1 plan); database: per-migration rollback scripts; live backup workflow `db-backup.yml` (manual, gated). |
| Hosting plans | Vercel **Hobby** (Pro-only features are greyed out in the project); Supabase **Free** (Pro approved for the pilot, not yet switched). |
| Notification emails | Built but **off everywhere** (no Gmail variables in Vercel). Details in §7. |

## 2. Error monitoring (W2a) — Sentry, minimum useful setup

**Why Sentry:** the organisation already exists, the app's scrubbing design is reviewed and tested, the free Developer
plan covers one user, email alerts, 5,000 errors a month and one uptime monitor. Vercel Hobby logs are too short-lived
to investigate after the fact. No tracing, no session replay, no logs product.

**SDK:** `@sentry/nextjs` 11.16.0 (supports Next 16). Off unless `NEXT_PUBLIC_SENTRY_DSN` is set, so a build without it
behaves exactly as today.

**Files:**

| File | Change |
| --- | --- |
| `package.json` | add `@sentry/nextjs` |
| `src/lib/monitoring.ts` (new, website only) | shared options: environment (`production`; `staging` for branch `m3-dev`; `preview` otherwise, from `VERCEL_ENV` / `VERCEL_GIT_COMMIT_REF`), release = commit SHA, `scrubEvent`, `scrubBreadcrumb`, `ignoreErrors`, and `reportUnexpected(area, error)` |
| `src/lib/monitoring.test.ts` (new) | scrubbing and filtering tests (§3) |
| `src/instrumentation.ts` (new) | server init (Node runtime; the site has no edge code) and `export const onRequestError = Sentry.captureRequestError` — catches every server-page and route-handler error, including W1's `LoadError` |
| `src/instrumentation-client.ts` (new) | browser init |
| `next.config.ts` | wrap with `withSentryConfig`: source maps uploaded only when `SENTRY_AUTH_TOKEN` is present, hidden from the browser and deleted after upload; no tunnel route; SDK telemetry off |
| `src/app/error.tsx`, `src/app/global-error.tsx` | report the error once (`captureException`), page unchanged |
| booking paths: `club/[slug]/PlayerGrid.tsx`, `courts/BookSheet.tsx`, `bookings/[id]/CancelButton.tsx`, `pay/[id]/PayPanel.tsx`, `staff/[slug]/DayCalendar.tsx` | where `friendlyError` falls back to "Something went wrong", also call `reportUnexpected("booking", error)`; known refusals (taken, blocked, hold, validation) are not reported. `friendlyError` itself stays untouched (it is shared with the app) |
| sign-in: `app/auth/callback/route.ts`, `app/login/LoginForm.tsx` | report a failed code exchange (Google return) and sign-in calls that fail for a reason other than a wrong or expired code (e.g. Supabase unreachable); never the code itself |
| `api/club-media/route.ts`, `api/pay/simulate/route.ts` | the five `console.error` cases also reported (they mean data needs attention) |
| `src/app/api/monitoring/test/route.ts` (new) + a button on `/admin` | **staging and previews only:** answers *not found* in production for everyone, and elsewhere only to an admin; raises one server and one browser test error with fixed messages (T3) |

**What a report contains:** error type, message (scrubbed), stack (readable with source maps), route path without
query string, environment, release, browser/OS family, tags `area` (`booking`, `auth`, `server`, `client`) and Supabase
error `code` where present.

## 3. Privacy and security of monitoring (W2a) — corrected after review (22 Nov)

**Principle: no free text leaves the site.** Masking text with patterns cannot be trusted with arbitrary error messages
(any message can carry a name, a row value or a code in a shape no pattern expects). So messages are not masked — they
are **withheld**, and what is sent is built from fixed parts. `beforeSend` rebuilds every event from an allowlist.

| Part of an event | What is sent |
| --- | --- |
| Messages from our own reporting (`reportUnexpected`) | **only predefined messages** from a fixed list (e.g. `booking: unexpected database error`, `auth: code exchange failed`), with tags `area` and `code` (a Supabase/Postgres error code or HTTP status — never its message, details or hint) |
| Exception message (uncaught errors, error boundaries) | **withheld** (`[withheld]`) unless it is one of our own fixed messages (W1's `Couldn't load …` labels, the staging test messages) or a framework message with no data in it (React's numbered production errors, chunk-load failures by file name). The exception **type** is kept |
| Stack | file (relative to the app, no server paths), function, line and column only; no source lines, no local variables |
| URL, route, breadcrumbs | path only, **IDs replaced** (`/bookings/:id`); no query string anywhere (so no sign-in codes); fetch and navigation breadcrumbs keep method, normalised path and status; UI, console and all other breadcrumbs dropped |
| Request | method and normalised path only: no headers, cookies, body or query |
| user, IP, server name, `extra`, modules, other contexts | dropped (`sendDefaultPii: false` as well); kept contexts: browser, OS and runtime name and version |
| tags | allowlist: `area`, `code`, `status`, environment and release |
| secrets | only the public DSN reaches the browser; the source-map upload token is build-time only (build leak check, as in W1) |

**Tests:** unit tests feed events carrying a cookie, a bearer token, `/auth/callback?code=…`, an email, a phone number,
a name in a message, a database row in `extra` and in a Supabase error's `details`, a user object and source lines, and
assert none survives; an integration test runs the **real Sentry SDK** with a capturing transport and checks the exact
JSON it would send. Expected refusals (`slot_taken`, `hold_conflict`, wrong or expired code) produce no event.
**Staging:** the received events are opened in Sentry and their JSON checked field by field (T3).

## 4. Alerts (W2a) — Sentry issue alerts by email, production only

| Rule | Condition | Why |
| --- | --- | --- |
| A1 New problem | a **new issue** appears in `production` | the first sign of a new failure |
| A2 Regression | a resolved issue happens again in `production` | a fix did not hold |
| A3 Booking or sign-in burst | issue tagged `area:booking` or `area:auth` seen **more than 3 times in 1 hour** | booking and sign-in are the critical paths |
| A4 Site down | uptime monitor on `/api/health` fails (2 checks in a row) | the site or the database is unreachable |

**Not alerted (filtered before sending):** expected refusals; wrong or expired email codes; aborted requests and
offline phones (`Failed to fetch`, `Load failed`, `AbortError`); browser-extension noise; 404s. Staging and preview events
are recorded but never alert. Sentry spike protection stays on. Recipient: Paul's email (one user on the free plan).

## 5. Health check and uptime (W2a)

`src/app/api/health/route.ts` (new): `GET` performs one cheap public read on the database (as the anonymous visitor,
e.g. one row of `sports`), with a 3-second timeout. Answers `200 {"ok":true}` or `503 {"ok":false}` — no details, no
data, `Cache-Control: no-store`. Unit tests for both answers. Sentry's included uptime monitor checks it (interval set in
Sentry) and drives A4.

## 6. Operations runbook (W2a) — `docs/ops/runbook.md` + project copy

1. **Detect:** Sentry email (A1–A3), uptime email (A4), a club or player report (WhatsApp, Help & Feedback).
2. **Classify:** *critical* — no one can sign in or book, wrong bookings, data exposure; *major* — one area broken
   (calendar, payments list, photos); *minor* — cosmetic. Target: critical acted on the same day.
3. **Investigate:** Sentry issue → release (commit) and route; Vercel deployment and runtime logs (short retention);
   Supabase logs and the database checks in `supabase/tests`; reproduce on staging, never by writing to live.
4. **Recover:** code — Vercel Instant Rollback to the previous production deployment, then revert on `main`; database —
   the migration's rollback script; data loss — restore the verified backup into a new project (`docs/m3/16-live-backup.md`);
   leaked secret — rotate (OPS-1 procedure).
5. **Verify healthy (read-only):** `/api/health` 200; home, Play, a club page load; email-code and Google sign-in;
   staff calendar and club settings open; Sentry quiet for 30 minutes. No test writes on live.
6. **Record:** a short incident note in the project (what, impact, cause, fix, prevention).

## 7. Notification emails (W2b) — assessment; not enabled

**How it works today:** database functions create notifications (join requests, accepted or declined, game full,
started, closed, cancelled, chat messages, booking linked or moved). `POST /api/notify/email` (signed-in user,
service key) claims up to 20 pending rows (`claim_notifications_to_email`, re-claimable after 5 minutes), sends each
through Gmail SMTP (`GMAIL_USER`, `GMAIL_APP_PASSWORD`), marks the sent ones. No variables are set, so it sends nothing.

**What stops it being reliable:**

1. **Triggered only by a browser:** the route runs only after a game action or chat message on the **website**
   (`MatchActions.tsx`, `MatchChat.tsx`). Actions from the apps, and notifications created by other events, wait until
   someone happens to act on the website — possibly hours later, or never.
2. **No visible opt-out:** emails say "turn off *Email me about my matches* in your profile", but no screen shows that
   setting any more (the profile saves `email_notifications` but has no control); it defaults to **on**.
3. **Links follow whoever triggered the send** (`origin` of the request), not a fixed site address.
4. **Sender:** a personal Gmail with an app password — fine for a pilot (Gmail caps daily sending), not a long-term
   sender; failures are silent today.

**Minimum to enable it reliably (W2b, after approval):** a visible opt-out on the website and the app, and a decision on
the default (recommended: **off until the player turns it on**); a dedicated CourtBook Gmail sender (Paul creates it and
the app password; stored only in Vercel Production, staging separately); a server-side trigger — a Supabase database
webhook on new notifications calling the route with a shared secret, plus a daily sweep for anything missed (Vercel
Hobby allows one daily cron); a fixed site address for links; send failures reported to Sentry; tests on staging with
two accounts. **Database change:** the webhook trigger (and a default change if decided) — its own migration approval.
The Supabase sign-in sender (code emails) is separate and already working on live; moving it to the same CourtBook
sender is a configuration step Paul can do at the same time.

## 8. Security housekeeping (OPS-1) — separate controlled operation; nothing done yet

From the Vercel inventory (22 Nov): **246** ready preview deployments were built while previews used live settings (207
of 35 other branches, 39 early `m3-dev` builds). They keep the live public settings and, presumably, the live service
key until deleted; all require a Vercel login.

1. **Delete them**, by deployment ID from a reviewed list (preview, built before 22 Nov 11:00 UTC), never "all
   unaliased deployments" (that would also remove old production deployments, which are rollback targets). Run by Claude
   through the dashboard with Paul's approval, or by Paul with the Vercel CLI. Recoverable for one day.
2. **Rotate the live service key — first establish its type** (Supabase live → Project Settings → API keys):
   - *new secret key (`sb_secret_…`)*: create a new secret key → Paul updates the Vercel Production entry → redeploy
     production (same commit) → verify photo upload and admin pages → revoke the old key. No effect on the apps or on
     signed-in users.
   - *legacy `service_role` JWT*: it cannot be revoked on its own; disabling legacy keys would also disable the legacy
     public key, which the live app may use. Then: move the website to a new secret key, and plan the legacy disable
     together with an app update. Decision at that point.
3. **Verify:** no preview built before the change remains; production works; the old key is refused.

## 9. Implementation order, acceptance and rollback

**Order (W2a):** one branch `w2-monitoring` → code and tests → GitHub checks → staging with Paul's Sentry project →
review → production approval.

**Paul's setup (credentials, ~15 minutes, guided):** in Sentry org `courtbook`: create project `courtbook-web`
(Next.js); in Vercel add `NEXT_PUBLIC_SENTRY_DSN` (Production and Preview), `SENTRY_ORG=courtbook`,
`SENTRY_PROJECT=courtbook-web`, and optionally `SENTRY_AUTH_TOKEN` (sensitive; the existing upload-only token); in
Sentry create alert rules A1–A3 and the uptime monitor A4 (steps provided).

**Acceptance:**

| # | Test | Passes when |
| --- | --- | --- |
| T1 | unit tests (§3, §5) and build leak check | green in GitHub CI; the upload token and service key absent from all browser files |
| T2 | build without the DSN | identical behaviour, no Sentry network calls |
| T3 | staging test error, server and browser (admin-only, staging-only test action) | arrives tagged `staging`, readable stack, and its JSON has no user, IP, cookie, header, query string, email, phone or code |
| T4 | expected refusal on staging (book a taken slot) | **no** event |
| T5 | `/api/health` | 200 normally; 503 when the database is unreachable (unit test) |
| T6 | after release, **controlled production check without a test endpoint** | production page code carries the DSN and environment `production`; Sentry's *Send test notification* on each alert rule delivers the email (A1–A3); the uptime monitor's first production checks arrive green and its alert is proven with a monitor pointed at a missing path (A4); the test route answers *not found* in production |
| T7 | uptime monitor | green; a deliberately failing check (wrong path in a test monitor) sends the A4 email |
| T8 | performance | added browser code measured (expected a few tens of KB); page times unchanged within noise |

**Rollback:** remove `NEXT_PUBLIC_SENTRY_DSN` in Vercel and redeploy (SDK off), or Vercel Instant Rollback; alert rules
can be muted in Sentry; the health route is read-only. No database change in W2a.

## 10. Approvals, costs and risks

| Item | Needs Paul | Cost |
| --- | --- | --- |
| Sentry project `courtbook-web` on the free Developer plan | account setup | $0 (Team $26/month only if a second person needs access or chat alerts) |
| Vercel variables for Sentry (DSN public; upload token optional) | entry by Paul | $0 |
| Uptime monitor (one included) | setup in Sentry | $0 |
| W2b: sender mailbox, app password, webhook secret, migration | separate approval | $0 |
| OPS-1 deletions and key rotation | separate approval | $0 |
| Supabase Pro (already approved for the pilot) | switch before real users | $25/month |
| Vercel plan | decision before a commercial pilot: Hobby is meant for non-commercial use (to confirm against Vercel's terms); Pro also keeps runtime logs longer | $0 now; Pro $20/month per member |

**Risks:** monitoring leaking personal data (allowlist + tests + manual JSON check on staging); alert noise or quota
use (filters, production-only rules, spike protection); ad blockers dropping some browser reports (accepted; server
errors are unaffected); a wrong upload token breaking the build (optional; the build continues without maps); the
SDK interacting with the W1 proxy (covered by T3 on staging).

## 11. Decisions (Paul, 22 Nov, after ChatGPT's review of PR #2)

1. **W2a approved:** Sentry free plan, privacy filtering, essential alerts, one database-aware health check, runbook —
   with the two corrections in §3 and §9.
2. **Source maps approved** with the existing upload-only token, build-side only.
3. **W2b deferred:** the notification-email problems (§7) stay documented as a separate pilot-readiness task.
4. **OPS-1** after W2a and before onboarding real users; no cleanup or rotation authorised yet.
5. **Vercel:** Hobby for non-commercial testing; plan the Pro upgrade before a commercial pilot.
