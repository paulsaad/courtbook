# M5 — Stop Sentry keeping an approximate location for app reports (PREPARED, NOT EXECUTED)

Decided 23 Nov 2026: prepare this change, do not execute it. It changes production monitoring, because the
`react-native` Sentry project receives both staging and (once switched on) live app reports. **Executing it needs
Paul's explicit go.** Until it is applied *and* verified, `/privacy` keeps disclosing the approximate location, and the
store answers declare it (store package §2/§3).

## Why a setting, not code

Received staging events (`docs/m5/crash-privacy.md`) carry `user.geo` (city, region, country) on every app report:
JS errors, JS messages and native crashes. No IP address is stored, and the app already sends
`sdk.settings.infer_ip = "never"`.

Sentry's documentation (Server-Side Data Scrubbing) says two things:
- geographic information is derived from the IP address even when IP storage is off;
- removing it needs an Advanced Data Scrubbing rule.

A native crash is built outside our JavaScript, so a server-side rule is the only change that covers every app
report.

## The change

| | |
| --- | --- |
| Where | Sentry → organisation `courtbook` → project **`react-native`** → Settings → Security & Privacy → **Advanced Data Scrubbing** → Add rule |
| Rule | Method **Remove**, Data type **Anything**, Source **`$user.geo.**`** (Sentry's own example for removing all geo information) |
| Also confirm (read only, no change) | "Prevent Storing of IP Addresses" for this project and the organisation. Note the current value in this file |
| Not touched | Project `courtbook-web` (its events carry no geo or IP), client keys, DSNs, alerts, rate limits |
| Who | Paul, signed in to Sentry (owner). Claude can drive it through the built-in browser only after Paul's go |
| Undo | Delete the rule (same page). Events received while the rule was on stay without geo |

## Verification (before any wording changes)

1. Run **Mobile Android tests**, suite `crash-privacy`, on any branch that has it (staging only; nothing published).
2. In Sentry, open the events in the printed time window: two JS reports and one native crash. Each must have **no
   `user.geo`**, and no IP address. Check the event JSON, not the list view.
3. Record the event IDs and the result in `docs/m5/crash-privacy.md`.

## Only after it is verified

- `/privacy`: remove the "approximate location (country and city)" item under *Error reports and server records*,
  and the last sentence of the "GPS or device location" item. Update the legal tests that check them. The source
  comment next to the item points here.
- Store package §2: remove Location → Coarse Location. §3: remove Location → Approximate location.
- Evidence file: mark the row "verified removed", with the event IDs.

If the check in step 2 still shows `user.geo`, change nothing on the page and report back.
