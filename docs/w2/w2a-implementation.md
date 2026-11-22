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
| Test errors, only on a Vercel Preview connected to the staging database and only for an admin (404 everywhere else): server test, server privacy probe, browser test, browser privacy probe | `api/monitoring/test/route.ts`, `admin/monitoring/`, `lib/monitoringTest.ts` (no link in the menus) |
| Incident runbook | `docs/ops/runbook.md` |
| CI: no source maps and no Sentry token in the build output | `.github/workflows/web-checks.yml` |

Shared mobile files (`fees`, `geo`, `levels`, `time`, `types`) are unchanged; `friendlyError` is untouched.

## The event, field by field (what `scrubEvent` keeps)

| Field | Sent |
| --- | --- |
| message | one of `SAFE_MESSAGES`, otherwise `[withheld]` |
| exception | type if it is an error class name (`TypeError`, `LoadError`, `DOMException`), else `Error`; value only if fixed (ours; a `LoadError`'s "Couldn't load …"; React's error number); mechanism type (lower-case name) and handled flag |
| stack frames | file (see below), function name only in JavaScript name format — an identifier or a dotted path of up to 6 identifiers, `<anonymous>` allowed as a part, optional `async `/`new ` prefix, no other spaces or punctuation (else `?`), line and column (whole numbers), in-app flag (boolean); no module, source lines or variables |
| our URLs and paths | **route template only** (`/club/:slug/info`, from the list of the site's routes, `ROUTES`); a path matching no route → `/[unmatched]`; build files under `/_next/` kept if hash-shaped; no query or fragment anywhere |
| Supabase URLs | `/rest/v1/<table>`, `/rest/v1/rpc/<function>`, `/auth/v1/<endpoint>` (one identifier); everything else, including all storage paths, `[redacted]` |
| other URLs | listed hosts (Google fonts, Sentry) as host only; any other or spoofed host → `[redacted]` |
| frame files | browser: our `/_next/` build files; server: paths inside `.next/` or `node_modules/`, or `node:` internals; file-name characters only, nothing email-shaped; else `[redacted]` |
| request | known HTTP method and the route template |
| transaction | known HTTP method and the route template |
| breadcrumbs | navigation (from/to) and network (method, URL as above, status) only; level and timestamp checked |
| tags | one shape each: `area` (fixed list), `code` (code-shaped), `status` (HTTP status), `runtime` (node/edge/browser) |
| contexts | browser, OS, runtime: name only from a fixed list of known names (else the context is dropped); version only if version-shaped (`131.0.6778.135`, `v22.11.0`); trace ids (hex) |
| kept for reading the error | environment (fixed list), release (commit SHA only), SDK name and version, source-map ids (`debug_meta`: type `sourcemap`, debug id, build file only) |
| never | user, IP, server name, extra, modules, fingerprint, dist, SDK integrations and packages, other contexts |

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

## Review round 2 (ChatGPT on PR #3, 22 Nov) — all three accepted

1. **High — short arbitrary path segments survived.** Correct: the old normaliser only replaced segments that looked
   like IDs, so `/p/jana` passed. Now every path on our site is matched against the site's own route list and sent
   as its template; an unknown path is `/[unmatched]`. A test checks the route list against the `src/app` folders, so
   a new page cannot be forgotten (it would fail CI, not leak). Supabase and third-party URLs reduced as above.
2. **Medium — some metadata forwarded unchecked.** Correct: frame function names, fingerprint, `debug_meta`, SDK
   details, release, environment, tag values and context values went through as given. Each now has a strict
   format; fingerprint, dist, module and SDK integrations/packages are dropped. Source maps still work: the frame file
   and the `debug_meta` file are normalised the same way (tested), and the debug id is kept.
3. **Medium — test errors allowed everything except production.** Correct. Now an explicit allowlist: only
   `VERCEL_ENV=preview` **and** a Supabase URL of exactly `https://<staging project>.supabase.co`. Production, local,
   unknown environments and a preview connected to any other database answer 404.

Kept as approved: sessions disabled; the browser SDK loaded as a separate file. SDK collection (`dataCollection`) all
off and no location for Sentry to add: see the staging results below.

## Review round 3 (ChatGPT on `d1432f1`) — accepted

**Medium — free text in function names and contexts.** Correct: the character-class checks accepted "Jana Probe".
Function names now must have JavaScript name format (see the table); context names come from a fixed list of known
browsers, systems and runtimes, and versions must be version-shaped. Regression tests with fake personal data: unit
tests on both validators, and on the wire with the real server SDK (hostile names and contexts set on the scope →
`?` and dropped). Source-map matching confirmed with the real browser SDK: with a build-style debug id registered for
a `/_next/` chunk, the sent event carries `debug_meta` whose `code_file` equals every frame's `abs_path`.

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
| `lib/monitoring.test.ts` (39) | message withholding; route templates (short and arbitrary segments → template or `/[unmatched]`); Supabase, third-party and spoofed hosts; frame files; every metadata field rejected when malformed or carrying fake data; an event carrying a user, cookies, a bearer token, a sign-in code, an email, a phone, a name, source lines and variables comes out with none of them; tags, contexts and breadcrumbs reduced; environment names; options |
| `lib/monitoring.sdk.test.ts` | **real server SDK** + recording transport: our reports arrive as fixed messages with codes, an exception and its cause as `[withheld]`, no user / extra / server name, no session, no IP instruction, none of the fake data anywhere on the wire |
| `lib/monitoring.browser.test.ts` | **real browser SDK** in jsdom: uncaught error after a click, form input and console output, page URL with an ID, query and fragment — none of it on the wire |
| `lib/report.test.ts` | the text shown is unchanged; only fallbacks are reported; expected refusals and the person's own sign-in mistakes are not; codes filtered |
| `api/health/health.test.ts` | 200 / 503, timeout, no-store, body `{ok}` only |
| `lib/monitoring.routes.test.ts` | `ROUTES` equals the pages and routes under `src/app` |
| `lib/monitoringTest.test.ts`, `api/monitoring/test/route.test.ts`, `admin/monitoring/page.test.tsx` | allowed only on a preview connected to staging; 404 on production, local, unknown, and a preview on the live database, even for an admin; 404 for non-admins; the test errors otherwise |

Full suite **443 tests** (26 files), passing on three consecutive full runs; `tsc` clean; production build without any
Sentry variable succeeds; shared first-load JavaScript **136.0 KB gzip** (main: 131.7 KB; +4.3 KB in total, the route
list and checks included);
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
| S8 | in S1–S2 JSON: request URL, transaction, breadcrumbs | route templates only (`/admin/monitoring`, `/api/monitoring/test`); no query string |

### Staging results (22 Nov): all eight pass on `24e20d8`

Setup done by Paul: Sentry project `courtbook-web` (Data Scrubber, default scrubbers, Prevent Storing of IP Addresses
on); four Vercel variables, Preview only (verified by name and scope, values not read; Production entries unchanged);
staging Supabase redirect URL `https://courtbook-git-w2-monitoring-paul-bc50.vercel.app/**` added (exact address only,
Site URL unchanged) so Google sign-in works on this preview.

| # | Result |
| --- | --- |
| S1 | 4 events per round, environment `preview`, release = the commit; fixed messages as written, probes `[withheld]` |
| S2 | full stored JSON of every event scanned: none of the fake data, no IP, cookies, headers or query strings; **no user data at all** from `24e20d8` (see fixes 3–4) |
| S3 | source maps applied by debug id: browser `src/app/admin/monitoring/MonitoringTest.tsx:10`, server `src/app/api/monitoring/test/route.ts:13–14`, with functions and source lines (from `2eef572`) |
| S4 | "That slot was just taken." shown; no event for the refusal or the cancellation (none after 16:42:18 UTC, checked 17:05) |
| S5 | every `.js.map` 404, no `sourceMappingURL`, no token in page code; build log: maps uploaded |
| S6 | `200 {"ok":true}`, no-store (from `934d6e2`) |
| S7 | `/admin/monitoring` signed out shows "Not found"; `/api/monitoring/test` 404 |
| S8 | request URL and transaction are route templates; breadcrumbs routes, `/[unmatched]` or Supabase table names; no query strings |

**Defects found on staging and fixed (each with a test that fails on the old code):**

1. `934d6e2` — the health check read `sports.id`, which does not exist (`code`): `/api/health` always 503.
2. `2057594` — left unset, `@sentry/nextjs` generates a public `/sentry-tunnel` route on Vercel builds only;
   now `tunnelRoute: false`, and CI builds as Vercel does and fails if the route appears.
3. `2eef572` — (a) `@sentry/nextjs` renames build files to `app:///_next/…` before `beforeSend`; the scrubber redacted
   them, so no source maps (S3 failed). Now accepted. (b) SDK 11 removed `sendDefaultPii` (silently ignored);
   `dataCollection` defaults to collecting everything and asked Sentry to infer the IP. All collection now off.
4. `24e20d8` — Sentry still added the sender's city (`user.geo`) from the connection, whatever `infer_ip` and the IP
   setting say. Every event now carries `user: { ip_address: null, geo: {} }`; tested against Sentry directly
   (without it the city is stored; with it, no user data).

**Not done / follow-ups:** delete the preview test issues in Sentry (COURTBOOK-WEB-1 to -8; six events carry the
tester's city, from before fix 4) — Paul's approval; the staging redirect URL can be removed after W2a closes; alerts
A1–A4 and Production variables at release.

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
