# Chat notices without message text (H4; draft, not applied)

**Decision (Paul, 26 Nov):** chat-message text never goes into notifications or notification emails. A chat notice
says "New message from <name>"; the text is read in the game itself.

## What changes

| | Before | After |
| --- | --- | --- |
| New chat notice (`match_message_notify`) | "Karim Haddad: <first 80 characters>" | "New message from Karim Haddad" (who is told, hidden games, blocks and one unread notice per game: unchanged) |
| Email (`claim_notifications_to_email`) | the stored text | a chat notice is always "New message from <name>", whatever the row holds |
| Existing chat notices | the copied text, also of deleted or hidden messages | rewritten to "New message from <name>" (every row of the kind; no matching against messages) |
| Website email route (`/api/notify/email`) | sends `body` | `emailSafe()`: a chat notice not in the new form is sent as "New message in one of your games" (also before the database change, and after a rollback of it) |
| Other notification kinds, push text (0072), reports | — | unchanged |

**Moderation evidence:** `reports.snapshot` keeps the reported message's text. It is readable only through the
`admin_*` functions; no role can read the table (preflight F6 checks this). Hiding a message does not touch it.

## Files

- `sql/chat_notices_without_text.draft.sql`: the change (one transaction, idempotent).
- `sql/chat_notices_without_text.down.draft.sql`: the rollback.
- `supabase/live/chat_notices_preflight.sql`, `chat_notices_postcheck.sql`: read-only checks.
- `supabase/tests/chat_privacy/notice.sh`: the local suite.

## Order (each step with Paul's go; staging first)

1. **Preflight** (read-only). F1/F2 confirm the two functions are exactly the versions the draft replaces. F3 counts the
   chat notices to be rewritten. Write down F4 (`others_checksum`) and F5 (`report_snapshots`). Any STOP: do not apply.
2. **Apply** the draft as one migration (number assigned at that time).
3. **Postcheck** with F4 and F5:
   `psql -v others="<F4>" -v snapshots=<F5> -f supabase/live/chat_notices_postcheck.sql`. All rows must be `ok`.
4. The website with `emailSafe()` may be deployed before or after; it is correct with either database.

## Rollback assessment

- The two functions can be restored exactly (the down file; tested: both match the 0074/0026 bodies byte for byte).
  New notices would then carry the excerpt again.
- **The rewritten notices cannot be restored:** the excerpts are discarded and kept nowhere, by design. After a rollback
  they stay "New message from <name>". Nothing else was changed, so nothing else needs restoring.
- Emails already sent with text before the change cannot be recalled.

## Local evidence

`PSQL="sudo -u postgres psql" bash supabase/tests/chat_privacy/notice.sh`. It builds 0001–0093 plus a legacy state made
with the current trigger: a deleted message, a reported-and-hidden one, a grouped notice and a live one.
- Preflight 6/6 ok; the postcheck run before the draft stops (control); postcheck 5/5 ok after it.
- Tests C1–C9:
  - historical rewrite;
  - new messages;
  - duplicates and grouping;
  - sender delete;
  - admin hide with the evidence kept;
  - privacy boundaries;
  - the email claim;
  - other kinds unchanged;
  - trigger rules kept.
- Idempotent; rollback R1–R2; mutants 5/5.
- With the draft as a migration: `run.sh` 381/381, `m86/deletion86`, `m86/ported_deletion_races`, `m10/moderation`,
  `m3/hardening`, `m3/hardening_races`, `m3/safety`, `m3/live_0074`: all PASS.
- Website: `route.test.ts` 3 (1 fails on the current route).
