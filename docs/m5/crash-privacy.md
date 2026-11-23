# M5 — App crash reports: what leaves the phone, and what Sentry received

Review finding 1 (23 Nov 2026): the privacy policy claimed more than `mobile/lib/crash.ts` guaranteed.
This file records what was changed, and what Sentry **actually received** on staging from synthetic personal data.
No production monitoring setting was changed.

## What changed in the app (JavaScript, no native change, fingerprint unchanged)

The app now follows the website's rule: **no free text leaves the phone**. Every report is rebuilt from an
allowlist (`scrubEvent`). Nothing else is sent.

| Part | Rule |
| --- | --- |
| Message, exception text | Kept only if it is one of our fixed messages (`SAFE_MESSAGES`), an error code (`slot_taken`), a known connection failure, or the React error number. Otherwise `[withheld]` |
| Exception type | Kept if identifier-shaped, else `Error` |
| Stack frames | File, function (identifier-shaped only: no spaces, no `@`), line, column. No variables, no source lines. Paths with IDs or emails are rewritten |
| URLs (request, breadcrumbs, transaction, file paths) | No query, no fragment. UUIDs, long numbers, hex, tokens and phone-like segments become `:id`. Emails become `[email]`. Any other unusual segment becomes `:redacted`. Idempotent |
| Breadcrumbs | Navigation (from/to) and HTTP (method, URL, status) only. Filtered **as they are recorded** (`beforeBreadcrumb`), so the copy the native layer keeps for a native crash is clean too. Console, taps, messages and lifecycle breadcrumbs are dropped |
| Tags | `update_id` only |
| Contexts | Named fields of os, device (model, family, brand…; **no name**), app, runtime, react-native; short values only |
| Never | user, IP address, server name, extra, request body, headers or cookies, modules, fingerprint |
| Native options | `enableAutoSessionTracking: false` (sessions carry an installation ID), all automatic native breadcrumbs off, `attachThreads: false`, failed-request capture off |

Unit tests (`mobile/__tests__/crash.test.ts`) feed an SDK-shaped event carrying personal data in every field and
require that none of it survives.

## Verified on staging (emulator run 45191427054, 23 Nov 2026, 14:28–14:31 UTC)

This was an emulator test build of CourtBook Staging (environment `staging`, release
`app.courtbook.mobile.staging@0.3.0+1`), with the code at commit `0390bd0`.
- Flow 06 sends the **privacy probe**. It puts synthetic data (name "Probe Personname", `probe.person@example.com`,
  `+961 70 123 456`, a UUID, a token) into:
  - console, navigation, fetch and tap breadcrumbs;
  - extra, a context and a tag;
  - the error text and a message.
- Flow 07 then forces a **native crash** and relaunches the app.

Events read back from Sentry's API (read-only, through Paul's signed-in Sentry tab):

| Event | Kind | Probe values present? | Notes |
| --- | --- | --- | --- |
| `08a7da14…` | JS error (probe) | **None** | Title `Error: [withheld]`. Breadcrumbs: fetch, navigation `/profile → /booking/:redacted`, fetch `…/people/[email]/:redacted`. Tags: `update_id` + Sentry's own. No user ID, no IP. `sdk.settings.infer_ip = never` |
| `d07e4a24…` | JS message (probe) | **None** | Message `[withheld]`. Same as above |
| `dbf941d9…` | **Native crash** | **None** | The console breadcrumb was dropped, and the navigation breadcrumb arrived as `/courts → /booking/:id` |

The only matches for "Probe" were the function name `sendPrivacyProbe` and our own source lines. Sentry shows those
from the uploaded source maps; they are code, not data. The run's own check failed on that function name, because
the needle was too broad (fixed). It found nothing else.

### What Sentry received that the app does not control

1. **Approximate location on app reports.** Every app event, JS and native, has `user.geo` (city, region, country).
   Sentry derives it from the connection; no IP address is stored. A real iPhone report from 15 Nov shows the same.
   The website event checked has neither geo nor IP. Stopping it is a Sentry project setting. That is production
   monitoring, so it is **not changed: decision needed** (store package §9 E2b).
2. **Native crashes are built by Sentry's native SDK** (`beforeSend` does not run there). The received native crash
   carries:
   - `user.id` = `device.id` = **a random installation ID** (open question E2: answered *yes*);
   - `device.locale`, `device.timezone`, memory, storage, battery, charging, boot time, connection type, screen
     size, kernel version and the rooted flag;
   - the app's permissions and the last screen (`view_names`, already scrubbed);
   - the **system's own exception text**, which the app cannot filter.

   `device.name` was "Emulator" here. The earlier real iPhone report had no device name. On a real Android phone
   this is not verified yet.
3. Sentry adds its own tags from those contexts (device model, OS build, `os.rooted`, `user:id:…` on the native
   crash).

### Not possible in M5 without a native change

Filtering native crash reports needs native code: an Expo config plugin that gives the Android and iOS SDKs their
own `beforeSend`. That changes the native fingerprint, so it needs new builds. Tonight's builds stay unchanged.
Until then:
- the privacy page states these facts, with marked decisions;
- store answers §2/§3 say "declare unless removed";
- crash reporting stays **off in the live app** (no live DSN; L11).

## How to repeat the check

1. Run **Mobile Android tests**, suite `crash-privacy`, on the branch. It prints the time window.
2. In Sentry (project `react-native`, environment `staging`), open the events in that window. Search each event's
   JSON for the probe values in `mobile/lib/crash.ts` `PROBE_VALUES`.

`e2e/check_report.py --probe` checks the JS reports on their way out (device log). The received native crash can
only be checked in Sentry.
