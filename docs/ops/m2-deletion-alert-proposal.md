# M2 (0086): admin alert for deletions needing attention (R2) — PROPOSAL, Sentry unchanged

Status: **proposal only.** No Sentry setting has been read or changed for this. Before any change, read the existing
alert rules (read-only), then apply only with Paul's approval.

## What the code sends

Only from the retry route (`/api/internal/deletions/retry`), so **nothing is sent until R1 is active**. One message per
record, once (the record is then marked `alerted_at`):

| Field | Value |
| --- | --- |
| message | `account: deletion needs attention` (fixed, in `SAFE_MESSAGES`) |
| level | error |
| tags | `area=account`, `code=held` (newly held: legal hold, coach bookings, suspended) or `code=stuck` (not finished 1 h after closing, or 3 runs) |
| account id, name, email | **never**. The admin page shows which account |

The same scrubbing as every other event applies: allowlisted tags, no user, no request body (src/lib/monitoring.ts).

Two other fixed messages exist for engineering, not for alerting:
- `account: closing failed` (the website's close itself failed: nothing was closed);
- `account: deletion step failed` (an inline step failed; it is recorded and retried).

## Proposed rule

- Sentry → Alerts → Create alert → **Issues**:
  - **When:** a new issue is created, *or* an issue is seen more than 0 times in 1 hour.
  - **If:** the event's message equals `account: deletion needs attention` **and** tag `area` equals `account`.
  - **Then:** send an email to the CourtBook admin address (members: Paul).
  - **Action interval:** 1 hour.
  - **Environment:** one rule per environment, staging first.
- **Why an issue alert:** the messages group into one issue, so a rule on "seen in the last hour" emails once an hour
  at most, whatever the number of records.

## Interim (until approved)

The admin Deletions page lists every record that is not done: held or stuck, with attempts, last error code, next
try and "alert sent". Checking it is part of the admin's routine.

## Open points for review

- `alerted_at` is set after the message is handed to the SDK. If Sentry is not configured (no DSN) or unreachable, the
  record is marked alerted even though nothing arrived. The admin page still shows it. Alternative: mark only when a
  DSN is configured. Not done, to keep the route independent of Sentry configuration.
