# W2a — monitoring: implementation (for review)

Branch `w2-monitoring`, from `main` 26d6244 (W1 release). Plan: `docs/w2/plan.md` (PR #2), with Paul's decisions of
22 Nov and the two review corrections (no free text leaves the site; deliberate errors on staging only).
No database migration, no W2b, no OPS-1, nothing changed in production or in any external service.

## What it does

| Part | Where |
| --- | --- |
| What may leave the site (allowlist `beforeSend`, breadcrumbs, environment, shared options) | `src/lib/monitoring.ts` |
| Our own reports: fixed messages + codes; booking fallback detection; sign-in failures; error pages | `src/lib/report.ts` |
| Server SDK (`register`, `onRequestError`) | `src/instrumentation.ts` |
| Browser SDK, loaded as a separate file | `src/instrumentation-client.ts` |
| Source maps (upload only with the token; deleted from the output), bundle trimming, environment name | `next.config.ts` |
| Booking paths report only the unexpected: PlayerGrid, BookSheet, CancelButton, staff calendar (`run`) | call sites; `reserve.ts` now also returns the database error code |
| Sign-in: code exchange (server), Google start, code send, code check — 5xx only (server: also unreachable) | `auth/callback/route.ts`, `LoginForm.tsx` |
| The five `console.error` cases (club photos, simulated payment lookup) | `api/club-media`, `api/pay/simulate` |
| Error pages report browser-side errors (server ones are already reported by `onRequestError`) | `error.tsx`, `global-error.tsx` |
| Health check: one public read, 3 s limit, `200 {ok:true}` / `503 {ok:false}`, no-store | `api/health/route.ts`, `lib/health.ts` |
| Staging-only test errors (404 on production and for non-admins): server test, server privacy probe, browser test, browser privacy probe | `api/monitoring/test/route.ts`, `admin/monitoring/` (no link in the menus) |
| Incident runbook | `docs/ops/runbook.md` |
| CI: no source maps and no Sentry token in the build output | `.github/workflows/web-checks.yml` |

Shared mobile files (`fees`, `geo`, `levels`, `time`, `types`) are unchanged; `friendlyError` is untouched.

## The event, field by field (what `scrubEvent` keeps)

| Field | Sent |
| --- | --- |
| message | one of `SAFE_MESSAGES`, otherwise `[withheld]` |
| exception | type; value only if fixed (ours; a `LoadError`'s "Couldn't load …"; React's error number); mechanism type |
| stack frames | file and path without query, function, line, column, in-app flag; no source lines, no variables |
| request | method and path (IDs → `:id`, numbers → `:n`, token-like → `:token`, `@` → `:value`); no query, headers, cookies, body |
| transaction | method and the same normalised path |
| breadcrumbs | navigation (from/to paths) and network (method, path, status) only |
| tags | `area`, `code`, `status`, `runtime` |
| contexts | browser, OS, runtime (name, version); trace ids |
| kept for reading the error | environment, release, SDK, source-map ids (`debug_meta`), fingerprint |
| never | user, IP, server name, extra, modules, other contexts |

## Two things the tests found, and what changed

1. **Release-health sessions bypass `beforeSend`.** The real-SDK test caught the session envelope carrying a user id
   (`did`) and `ip_address: "{{auto}}"` (an instruction to Sentry to store the sender's IP) whenever any code sets a
   user. Sessions are now not sent at all (`BrowserSession` and `ProcessSession` integrations removed). The tests
   assert no `did` and no `{{auto}}` on the wire. Cost: no crash-free-sessions figure in Sentry.
2. **Bundle size.** Bundled normally, the browser SDK added **46 KB gzip** to the JavaScript every page loads
   (shared first-load files 131.7 KB → 177.8 KB, +35 %). Loaded as a separate file started before hydration, the
   increase is **2.4 KB** (→ 134.2 KB). Our own reports wait for that file, so none is lost; what can be missed is an
   uncaught browser error in the first moments of a page load, before the file arrives (server errors are unaffected).
   Chosen for a mobile-first site on Lebanese networks; reverting to the bundled form is a two-file change if the
   reviewer prefers coverage of the first moments.

Server reports (`report()` on the server) wait for the send (`flush`, 2 s at most) before the route answers, so a
serverless function frozen after its response cannot lose them. This affects only failure paths.

## Deviations from the plan

- `pay/[id]/PayPanel.tsx` is not instrumented: it shows the raw `detail` from `/api/pay/simulate` (tracked as F-PAY-1,
  to fix before real payments). The server side of that failure (payment lookup) is reported.
- Areas: `booking`, `auth`, `media`, `payment`, `page`, `test` (the plan's `server` / `client` are the `runtime`
  context instead). Errors caught by `onRequestError` carry no area; A1/A2 cover them.
- Chunk-load errors keep their type (`ChunkLoadError`), not the message (it contains a URL).
- Server stack paths stay as built (`/var/task/.next/server/…`): file names of our own build, no personal data,
  needed to apply source maps.

## Tests

| Test | Checks |
| --- | --- |
| `lib/monitoring.test.ts` (21) | message withholding; path normalisation; an event carrying a user, cookies, a bearer token, a sign-in code, an email, a phone, a name, source lines and variables comes out with none of them; tags, contexts and breadcrumbs reduced; environment names; options |
| `lib/monitoring.sdk.test.ts` | **real server SDK** + recording transport: our reports arrive as fixed messages with codes, an exception and its cause as `[withheld]`, no user / extra / server name, no session, no IP instruction, none of the fake data anywhere on the wire |
| `lib/monitoring.browser.test.ts` | **real browser SDK** in jsdom: uncaught error after a click, form input and console output, page URL with an ID, query and fragment — none of it on the wire |
| `lib/report.test.ts` | the text shown is unchanged; only fallbacks are reported; expected refusals and the person's own sign-in mistakes are not; codes filtered |
| `api/health/health.test.ts` | 200 / 503, timeout, no-store, body `{ok}` only |
| `api/monitoring/test/route.test.ts`, `admin/monitoring/page.test.tsx` | 404 on production even for an admin; 404 for non-admins on staging; the test errors otherwise |

Full suite 415 tests, stable over repeated runs; `tsc` clean; production build without any Sentry variable succeeds;
no `.map` file in `.next/static`; `mobile/scripts/check-shared.sh` passes; lint adds no finding (the 4 on `main` remain).

## Staging verification (after Paul's setup; Preview variables only)

On the branch preview (environment `preview`), signed in as an admin, `/admin/monitoring`:

| # | Action | Passes when |
| --- | --- | --- |
| S1 | buttons 1–4 | four events in Sentry, environment `preview`, release = the commit; 1 and 3 show the fixed test messages; 2 and 4 show `[withheld]` |
| S2 | open each event's **JSON** in Sentry | no user, IP, cookie, header, query string, email, phone, name or code from the probe; only the fields in the table above |
| S3 | stack of events 1 and 3 | readable (our file names and functions: source maps applied) |
| S4 | book a slot that is already taken | **no** event |
| S5 | `/_next/static/…/*.js.map` of the preview | 404 (maps deleted after upload) |
| S6 | `/api/health` | `{"ok":true}` |
| S7 | `/admin/monitoring` signed out or as a non-admin | not found |

## Paul's setup (account actions; nothing for production yet)

1. **Sentry → Projects → Create Project:** platform *Next.js*, name `courtbook-web`, alert setting *I'll create my
   own alerts later*.
2. **Project → Settings → Security & Privacy:** *Data Scrubber* on, *Use Default Scrubbers* on, **Prevent Storing of IP
   Addresses on**. (A second safety net; the site already sends none.)
3. **Project → Settings → Client Keys (DSN):** copy the DSN. It is public by design (it ends up in page code).
4. **Vercel → courtbook → Settings → Environment Variables**, each for **Preview only** (untick Production and
   Development):
   - `NEXT_PUBLIC_SENTRY_DSN` = the DSN
   - `SENTRY_ORG` = `courtbook`
   - `SENTRY_PROJECT` = `courtbook-web`
   - `SENTRY_AUTH_TOKEN` = the existing upload-only organisation token, marked **Sensitive**. If its value cannot be
     shown again, create a new one under Sentry → Settings → Auth Tokens (organisation token: upload only) and also
     replace the GitHub secret of the same name later.
5. Tell Claude: a new commit is pushed to rebuild the preview, then S1–S7 are run.

Alert rules A1–A3 and the uptime monitor A4 are created at release, with the production variables, under the release
approval (plan §4, §9 T6).
