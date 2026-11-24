# M12.4 — staging access audit, staging combination plan, Galaxy A17 acceptance tests

Prepared 24 Nov. **Nothing in this document has been executed.** Every step in §3 and §4 needs its own approval. The
72-hour deletion-scheduler trial (results due 27 Nov) comes first.

## 1. Staging address and protection (verified read-only in the Vercel dashboard, 24 Nov 22:30 UTC)

| Item | Value |
| --- | --- |
| Team / plan | `paul-bc50`, Hobby |
| Project | `courtbook-staging` (`prj_S634PxYHJiXTGgyBOePYytja8K1J`) |
| Builds | only `staging-web` (ignore command unchanged); latest Ready: `59a2f11`, deployment `courtbook-staging-qi7dcizbf-paul-bc50.vercel.app` |
| **Staging-web address** | **`courtbook-staging-git-staging-web-paul-bc50.vercel.app`** — the branch alias of that deployment. It matches `PAYMENT_SERVER.staging` in the app exactly |
| Project domain | `courtbook-staging.vercel.app` (production branch `main`, never built) |
| Vercel Authentication | on, **All Deployments** |
| Deployment Protection Exceptions | **none** (section present, "Add Domain" available on Hobby) |
| Protection Bypass for Automation | 1 secret ("GitHub deletion retries (staging)") |
| Shareable links / password / trusted IPs | none / off (Pro add-on) / off (Enterprise) |
| Variables (Preview) | Supabase URL, anon key, service key, `CRON_SECRET`, Sentry DSN. No payment variable |

- **Cost.** Vercel now offers Deployment Protection Exceptions free on every plan (changelog "Protect production
  deployments for free on every plan"). No upgrade is needed.
- **What an exception covers.** It applies to one preview domain. Adding only
  `courtbook-staging-git-staging-web-paul-bc50.vercel.app`:
  - makes that alias public;
  - keeps every per-deployment address (`courtbook-staging-<hash>-paul-bc50.vercel.app`) and `courtbook-staging.vercel.app` behind Vercel login;
  - leaves the main `courtbook` project untouched.
- **Consequence.** The alias always points at the newest `staging-web` build. Anything pushed to `staging-web` is
  public as soon as it is Ready, so a `staging-web` push then needs the same care as a release.
- **Not verified live.** I could not probe the staging address without credentials. The workspace and the web fetcher
  cannot reach `vercel.app`, and the browser pane is signed in to Vercel. Today's evidence that it is protected: the
  dashboard setting above, and the 24 Nov 13:50 probe (run 45407568111), which got a 302 to Vercel login without the
  bypass. The live checks in §2.4 are for the activation step.

## 2. Unauthenticated access audit (if the exception is added)

### 2.1 Website: what a signed-out visitor can open (code audit of every page and route on the combined branch)

| Open to anyone | Data shown |
| --- | --- |
| `/`, `/courts`, `/club/[slug]`, `/club/[slug]/info`, `/levels` | Published clubs, courts, prices, free times (`public_occupancy`: no player, guest or booking identity — test S2). Unpublished clubs: not found (S3, 0085) |
| `/login`, `/privacy`, `/terms`, `/delete-account`, `/account-closed`, `/pay/app-return`, `/auth/*` | Static or sign-in only |
| `/api/health` | `{"ok": true/false}` |
| `/api/pay/callback/[provider]` | Simulated provider: 404. It only ever asks the provider; it never trusts the body |
| `/api/internal/deletions/retry` | `CRON_SECRET` bearer required (401 otherwise) |
| `/api/monitoring/test`, `/admin/monitoring` | Admin only (404 otherwise) |

Everything else (bookings, `/me`, matches, coaches, staff, admin, pay, account, native pay) needs a CourtBook sign-in
and then row-level security.

### 2.2 Staging database through its public API

- **New exposure.** The staging Supabase URL and anon key are in the page code, so a public alias publishes them.
- **Anonymous reads.** These are governed by RLS, the same rules the live site already exposes to anyone. On the
  combined branch, `security.mjs` passes (34 checks, local). It covers:
  - a visitor reads nothing from bookings, payments, profiles, areas, favourites, prefs, deletions or staff;
  - `public_occupancy` carries no identity;
  - unpublished clubs are unreadable.
- **The other suites:** `run.sh` 381 checks; native payments 33 (including forged, anon-key and service-key tokens → 401).

### 2.3 Findings to decide before activation

| # | Finding | Proposal |
| --- | --- | --- |
| E1 | Anyone can **create a staging account** (email code) and then see what any signed-in player sees on staging: published clubs, open games with organisers' first names, their own bookings. Staging holds test accounts | Before activation, a read-only check that staging profiles hold only test identities. Optionally switch off new sign-ups in staging Auth during the test window (existing test accounts still sign in). Your call |
| E2 | Email-code requests to staging can be triggered by anyone (Supabase's own rate limits apply) | Accept for the test window |
| E3 | **Deletion-schedule probe.** The probe's "no bypass" call (`.github/workflows/deletion-retry.yml`, line 88) sends the **real bearer**. With the alias public, that call would reach the route and run the worker (200), and the probe would fail. Scheduled runs are unaffected (they send the bypass) | In the same approved change: make that call send no bearer and expect 401 from the route. Do not run the probe by hand until then |
| E4 | With the alias public, `CRON_SECRET` alone protects the retry route (as on production) | Already the design; secret is 64 characters, Preview-only |
| E5 | Native payment endpoints are reachable by any signed-in staging account | Simulated provider only; demo clubs only (0093); the feature switch stays off until §3 step 5 |
| E6 | Old staging deployments stay protected; only the alias opens | None |

### 2.4 Live checks at activation (I run them; read-only)

Before adding the exception, and again after, from outside Vercel (a GitHub Actions job with no secrets):

1. `GET /` on the alias. Before: 302 to vercel.com. After: 200 CourtBook.
2. `GET` the deployment's own address (`courtbook-staging-<hash>-…`) and `courtbook-staging.vercel.app`: still
   302/401 after.
3. `GET /api/health`: `{"ok":true}` only.
4. `POST /api/internal/deletions/retry` with no bearer: 401.
5. `POST /api/native/pay/status` with no token: 401 (or 503 while the switch is off).
6. `GET /admin/monitoring`, `/api/monitoring/test`: 404.
7. Anonymous PostgREST with the page's anon key, read-only:
   - `bookings`, `payments`, `payment_attempts`, `fee_charges` and `profiles` (phone) return no rows;
   - `public_occupancy` returns no identity columns.

Stop rule: any unexpected answer → remove the exception (Vercel → courtbook-staging → Deployment Protection → the
domain → Remove), then report.

## 3. Staging combination plan (order; each step separately approved)

**The combined website commit** = `origin/staging-web` (`59a2f11`) merged with `origin/m12-4-native-payments`
(`f7e5b3c`), which brings #34 and the release candidate with it.

**Trial merge (24 Nov, local worktree, discarded, never pushed):**
- One conflict, in `src/app/api/account/deletionRoutes.test.ts` (test file only). Take staging-web's side, as PR #35
  documents.
- `vercel.json` is staging-web's, so the deletion schedule keeps running.
- Combined results, all locally on the disposable DB:
  - website: tsc ok; vitest 842 passed (1 skipped);
  - app: tsc ok; jest 777;
  - `run.sh` 381; fee_online pass;
  - native 33/33; journey pass; security pass.

| # | Step | Changes | Pass | Rollback |
| --- | --- | --- | --- | --- |
| 0 | Deletion trial final results reviewed and accepted | — | your acceptance | — |
| 1 | Release-candidate staging steps for 0087–0092 (`docs/ops/release-candidate-staging.md`) | staging DB | as in that procedure | its rollbacks |
| 2 | 0093 by the PR #35 procedure (check → preflight → apply → postcheck → functional → smoke) | staging DB | 11 + 12 rows ok; 60 checks; 0 leftovers | `m12_1_rollback` |
| 3 | Push the combined commit to `staging-web` (no new variables: native endpoints answer 503) | staging website | Ready; page code uses `pwznauyioqykdwodwpvx`; the alias still asks for Vercel login; deletion schedule listed; next Sentry check-in ok; `/api/native/pay/start` → 503 | redeploy `59a2f11` |
| 4 | Vercel `courtbook-staging` → Preview, branch `staging-web`: `NATIVE_PAYMENTS=1`, `PAYMENT_APP_SCHEME=courtbook-staging`, `PAYMENT_SITE_URL=https://courtbook-staging-git-staging-web-paul-bc50.vercel.app`. **`PAYMENT_PROVIDER` stays unset** (simulated). Redeploy | staging website | env names only, scoped to staging-web; native status → 401 without a token | delete the three variables, redeploy |
| 5 | **Activation (separate approval):** Deployment Protection Exception for the alias only, with the E3 probe fix in the same change | public alias | §2.4 checks 1–7 | remove the exception |
| 6 | Demo club `fee_online`, fee $1 (staff settings; the DB allows it only for demo clubs) | staging data | club shows fee_online | `demo_at_desk` |
| 7 | Staging app build with the feature on: a new EAS profile `staging-payments` = `staging` + `EXPO_PUBLIC_FEE_PAYMENTS=1` (same bundle id, same `staging` channel; no other setting changes) | an APK | installs over CourtBook Staging; fee club shows "Reserve and pay fee" | reinstall the previous staging APK |
| 8 | Galaxy A17 acceptance (§4) | test bookings on the demo club | §4 all pass | — |
| 9 | Close: demo club back to the desk; remove the exception; optionally clear the three variables | — | alias asks for Vercel login again | — |

**Caution for step 7.** Any later `eas update` to the `staging` channel from a build without the variable turns the
feature off on the phone. That is the safe direction. Publish payment-test updates only from the `staging-payments`
profile.

## 4. Galaxy A17 acceptance tests (for Paul; prepared, not run)

Setup:
- the staging app from step 7;
- signed in with test account A;
- staging demo club set to fee_online, fee $1;
- I watch the staging database read-only during the session (the "Developer check" column).

| ID | Do | You should see | Developer check (read-only) |
| --- | --- | --- | --- |
| A1 | Courts → demo club → pick a free time | Button "Reserve and pay fee". Text: court price paid at the club, CourtBook booking fee $1 paid online, 10-minute hold, the refund sentence | — |
| A2 | Tap Reserve and pay fee | "Pay the booking fee to confirm"; club, court, date and time; Court price "Pay at the club"; CourtBook booking fee $1 "Pay online now"; countdown about 10:00; "Test mode: this is a demo club. No real money is taken."; the sentence "The CourtBook booking fee is not refunded if you cancel. It is refunded if the club cancels or your booking cannot be confirmed." | booking `pending`, payment `fee_only` `pending` |
| A3 | Tap Pay booking fee twice, fast | One payment only; then "Court booked", "Booking fee paid. Pay $25 at the club." (the demo court's price) | one attempt, `succeeded`; one charge `kept`, `collected=false`; booking `confirmed` |
| A4 | Bookings tab → that booking | Confirmed; Court price "Pay at the club"; CourtBook fee "$1.00 paid" | — |
| A5 | Cancel booking (more than 6 h ahead) | "…The $1.00 booking fee is not refunded when you cancel. It is refunded if the club cancels." Then cancelled | charge stays `kept` |
| A6 | New hold → leave the app 1 minute → come back | Same screen, countdown has moved on | — |
| A7 | New hold → swipe the app away → reopen → Bookings → the booking → Pay booking fee | Same hold; nothing charged | still one pending booking |
| A8 | New hold → airplane mode → Pay | "You're offline, so nothing was sent." | no attempt |
| A9 | New hold → wait 10+ minutes on the screen | "Your hold time is up" → Check payment → "Hold ended … No fee was taken." | booking `expired`, no charge |
| A10 | New hold → any club → try to reserve another time | "Finish your held booking first", disabled, "Go to held booking" | — |
| A11 | New hold → Release this court → Release | Back on Courts; the time is free again | booking `expired`, payment `expired`, no attempt |
| A12 | Phone settings → Display → Font size largest; open a new hold | All text readable, buttons not cut off, page scrolls | — |
| A13 | TalkBack on; payment screen | Reads title, countdown, prices, buttons in order | — |
| A14 | Sign out; sign in as account B; Bookings | Nothing of account A | — |
| A15 | Pay-at-the-desk club (staging) → reserve | Unchanged: "Court booked … Pay $X at the club", no payment screen | — |

Pass: every row as described; any difference is written down with a screenshot. Not testable on staging (needs a real
provider): the provider's own page, a real return from it, refunds, a lost callback with real money.

## 5. Conditions from the 24 Nov review — preparation status (nothing run on staging)

| # | Condition | Prepared |
| --- | --- | --- |
| 1 | Staging unchanged until the trial is accepted (27 Nov) | Nothing on staging changed. Trial check-ins 2–9 and the final evaluation (27 Nov 17:55Z) are scheduled; the GitHub retry workflow stays disabled |
| 2 | No inappropriate personal or production data before opening the alias | Draft PR #39: staging-db action `access_audit` (read only). Prints counts and 8-character ids only — no address, name, phone or text (the log is public). **Fails** on: personal-address accounts, stored phone numbers, names on personal accounts, desk phone numbers, free text by personal accounts, non-demo clubs, money marked collected. Each failure is a decision for you; nothing is changed by it |
| 3 | Can new staging registrations be disabled without affecting test accounts? | **Yes, by Supabase's documented behaviour; one point to verify.** See below |
| 4 | Deletion-probe correction (a request without the bearer must get 401) | Draft PR #38 (`deletion-probe-401`, base `main`, not merged). Harness PASS; 3 of 5 checks fail on the current `main`. The active trial (Vercel schedule) is untouched |
| 5 | Exception restricted to the verified alias | §1: `courtbook-staging-git-staging-web-paul-bc50.vercel.app` only. The §2.4 live checks confirm the other addresses stay protected |
| 6 | Separate approvals | Unchanged (§3) |
| 7 | Real payments off, Whish unimplemented | Unchanged. Bundle check: in a build without `EXPO_PUBLIC_FEE_PAYMENTS` the switch compiles to `undefined` (off). No credential, server-only function name or bypass header is in the app bundle |

### Registrations (condition 3)

- **The setting.** Supabase → staging project → Authentication → Sign In / Providers → "Allow new users to sign up".
  Supabase's documentation: with it off, only existing users can sign in. The change takes effect immediately and can
  be undone the same way.
- **What it blocks.** A first sign-in by an unknown email address (email code), and a first Google or Apple sign-in.
- **Existing test accounts are unaffected:**
  - Your staging app signs in with a password (`paul.tester@courtbook.test`, the staging-only password form): an
    existing account.
  - Email codes to existing accounts keep working (staging's built-in email only reaches a limited set of addresses
    anyway).
- **Staging tools are not sign-ups.** They create throwaway accounts either by SQL (`smoke`, `cancel`) or through the
  admin API (`web_accept`, `auth_checks`: `admin.createUser` / `admin.generateLink`).
- **To verify, not assumed:** that Supabase's admin API still creates users with sign-ups off. The Auth server's own
  documentation says invites remain possible. Proof: the first `web_accept` or `auth_checks` run after the switch
  (both are approval-gated).
- **The A17 test needs accounts A and B.** Create them **before** switching sign-ups off, or with the `tester` action
  (admin API).
- **Current value: unknown.** The browser here is not signed in to Supabase. `access_audit` prints it ("new sign-ups:
  ALLOWED / BLOCKED").

### Order at activation time (each separately approved; replaces nothing in §3, adds 4a–4c before step 5)

- **4a.** `access_audit` with `confirm_ref`, read only. Any failed row is decided by you before going on.
- **4b.** Test accounts A and B exist (`tester` action, admin API).
- **4c.** "Allow new users to sign up" off in staging Auth (your click). Then `access_audit` again; it must print
  "BLOCKED".
- **5.** Exception for the alias, with PR #38 merged in the same approved change. The §2.4 live checks run, then a
  manual probe run of the retry workflow. The probe stays manual and the workflow disabled unless you decide otherwise.
