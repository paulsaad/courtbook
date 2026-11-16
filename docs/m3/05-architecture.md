# M3 — 5. Engineering architecture

Principle: as in M1/M2 — the app talks to Supabase through database functions; the database
enforces every rule (game rules GR-1…GR-12 in `03-journeys.md` §3.0); the only server code added is
one delivery function (§5.5). No new paid tool. Payment model and booking safety unchanged.

## 5.1 Layers

| Layer | Choice | Reuses |
| --- | --- | --- |
| Screens | `app/games/index.tsx` (board), `app/match/[id].tsx` (detail), `app/match/[id]/chat.tsx`, `app/activity.tsx`; Club page gains `Games`; Bookings → Games rows tappable | expo-router stack + tabs; `_layout.tsx` back rule |
| Data | `lib/games.ts`, `lib/chat.ts`, `lib/activity.ts`, `lib/push.ts` | TanStack Query patterns (`lib/queries.ts`, `lib/bookings.ts`) |
| Shared logic | `mobile/shared/levels.ts` (byte copy; `npm run check:shared` covers it) | `shared/types.ts`, `shared/time.ts` |
| Errors | `lib/errors.ts` gains the game copy map (`04-ux-spec.md` §4.8) | `classify()` |
| Components | `GameCard`, `RequestRow`, `ChatBubble`, `Composer`, `ActivityRow`, `Badge`, `Stepper`, `ReportSheet`, `CourtLostSheet` | `PlayerSlots`, `Chip`, `Segmented`, `DateStrip`, `SportMark`, `StateView`, `Freshness`, `OfflineBanner`, `SignInPrompt`, `Button`, `Text`, `Icon` |
| Database | Existing RPCs + migrations 0067–0070 (`02-safety-review.md` §2.3) | — |
| Delivery | Queue = `notifications` rows; Edge Function `deliver` drained on a schedule (§5.5) | `claim_notifications_to_email` |

## 5.2 Query keys and refresh

| Key | Source | Stale | Refetch |
| --- | --- | --- | --- |
| `["games", filters]` | `open_matches` | 15 s | focus, reconnect, pull |
| `["club-games", clubId]` | `match_board(clubId, 14)` (list only) | 15 s | focus, reconnect |
| `["game", id]` | `match_detail(id)` — the only detail source | 5 s | focus, reconnect, after any mutation on `id` |
| `["game-people", id]` | `match_participants(id)` | 5 s | with `["game", id]` |
| `["chat", id]` | `match_messages_list` (§5.4) | — | 4 s while chat focused and app active |
| `["activity"]` | own `notifications`, newest 50 | 30 s | focus, push receipt, 60 s in foreground |
| `["unread"]` | count where `read_at is null` | 30 s | as above |
| `["agenda"]` | `my_agenda` | existing | invalidated by every game mutation |

Membership changes are never optimistic — the server's answer is shown (reservation discipline).
Chat sends are optimistic with a client id.

## 5.3 Write safety

- One call in flight per action (busy button ignores taps).
- Uncertain outcome (network error after the request left): never retry blindly; re-read
  `["game", id]` and show the real state.
- Chat send: the client makes the message `id` (UUID) and inserts it; a retry of the same message
  hits the primary key (`23505`) and is treated as sent after a re-read. Server sets `created_at`
  (0068 trigger).
- Membership, capacity, level fit and court state are never decided on the phone; fit is display
  only.

## 5.4 Chat polling — cursor verified

Polling every 4 s (accepted). `match_messages_list(p_match, p_after)` returns rows with
`created_at > p_after`, ordered by `created_at`; deleted rows come back with empty body and
`deleted = true`.

| Hazard | Strict cursor (`p_after` = newest seen) | Planned client rule | Evidence |
| --- | --- | --- | --- |
| Delayed commit: a message stamped earlier commits after a newer one was read | **Lost for good** | Poll with `p_after = newest seen − 10 s`, de-duplicate by `id` → recovered on the next poll | `docs/m3/repro/chat_cursor.sh` (16 Nov, replica): strict 0, overlap 1 — CONFIRMED |
| Equal timestamps | Lost if only one was seen | Same overlap + de-duplication | By construction (`>` with a 10 s overlap includes all equal stamps) |
| Reconnect / app back to foreground / screen reopened | Gap since last poll | Full reload (`p_after = null`) on focus, reconnect and open | — |
| Soft delete of an older message | Never returned (its `created_at` does not change) | Full reload every 60 s and on focus; own deletions applied locally at once | Same script: incremental 0, full reload 1 — CONFIRMED |
| Sender-chosen timestamps | Cursor poisoned (F2) | Server-side `created_at` (0068 trigger) — required | `m3_findings.sh` F2 |

**Why 10 s is enough:** in Supabase, API calls by signed-in users run with an 8-second statement
timeout by default, so a message insert cannot keep its stamp uncommitted for longer than that;
10 s covers it. Check before 0067: confirm that setting on staging and live (read-only). **Backstop:**
the 60-second full reload catches anything slower, so the worst case is a message appearing 60 s
late, never missing. Ordering in the app is `(created_at, id)`.

**Correction needed:** none beyond the 0068 trigger. No Realtime: nothing above needs it.

Cost at pilot scale: one small RPC per open chat every 4 s plus one full list per minute.

## 5.5 Push and email delivery

**Design: the `notifications` table is the queue; a scheduled job drains it.** No webhook.

```
any action / trigger ── insert notifications row (same transaction as the change)
                              │
pg_cron, every 15 s: if any row is due ──► net.http_post ──► Edge Function `deliver` (service role)
                                                                │ claim batch (lease, skip locked)
                                                                │ build copy from kind (S7)
                                                                ├─► Expo Push API ─► tickets
                                                                ├─► SMTP (opted-in email)
                                                                └─ stamp each row sent / failed
pg_cron, every 15 min ──► `deliver?receipts=1` ── read Expo receipts ≥ 15 min old ── drop dead tokens
```

Why no webhook: Supabase webhooks run on `pg_net`, which sends each request once and leaves failures
in a response table to be retried by the caller. A scheduled job that only looks at unsent rows
gives the same latency class (≤ 15 s plus sending time) with one mechanism, and recovers from every
failure below without extra code. Supabase Cron supports intervals down to one second.

**Columns (0070):** `notifications.push_claimed_at, push_attempts, pushed_at, push_failed_at`
(email keeps its existing `email_claimed_at, emailed_at`). `push_tokens (token unique, profile_id,
platform, app_variant, created_at, last_seen_at)`. `push_tickets (ticket_id, token, notification_id,
created_at)`.

| Concern | Mechanism | Guarantee stated honestly |
| --- | --- | --- |
| Duplicate triggers (two cron runs overlap, a slow function still running) | Claim = `update … set push_claimed_at = now(), push_attempts += 1 where id in (select … for update skip locked limit 100) and pushed_at is null and (push_claimed_at is null or push_claimed_at < now() - lease)`; lease 2 min | Two workers never claim the same row while a lease is live (tested T-DL2, mirror of suite 69 for email) |
| Failed or interrupted delivery | Row stays unsent; claimable again after the lease | Every notice is attempted until sent or given up |
| Retries and recovery | Backoff by lease: next claim after `2^attempts` min (max 30); give up after 6 attempts or 24 h → `push_failed_at` (visible in a staging check query) | A notice older than 24 h is never pushed (stale) |
| Crash after Expo accepted, before the stamp | Re-sent after the lease | **At-least-once, not exactly-once.** Window: between Expo's reply and the stamp (one SQL call). Rows are stamped right after each Expo batch reply to keep it small. A duplicate opens the same screen |
| Concurrent workers | `skip locked` + lease; function processes only what it claimed | No ordering promise across notices; each notice is independent |
| Expired tokens | Ticket error `DeviceNotRegistered` → delete token at once; receipts job deletes tokens whose receipt says `DeviceNotRegistered`; tickets older than 24 h are discarded (Expo clears receipts after 24 h); tokens not refreshed for 60 days are pruned | Dead tokens stop costing calls within ~15 min |
| Staging / live separation | Separate Supabase projects, each with its own cron job, function deployment and secrets (`EXPO_ACCESS_TOKEN`, SMTP, `DELIVERY_ENABLED`, `EXPECTED_APP_VARIANT`). Tokens reach a project only from the app variant bound to it (bundle id → project, as today). The function skips any token whose `app_variant` differs from `EXPECTED_APP_VARIANT`. **Live: cron job not created and `DELIVERY_ENABLED=false` until Paul approves** | A staging push can't reach a live user without two independent mistakes |
| Email | Same function calls the existing `claim_notifications_to_email` (unchanged). The web route `/api/notify/email` may keep running; both use the same claim, so they never send the same row concurrently | Same at-least-once statement as push |
| Content | Copy built from `kind` + game context; never `notifications.body` (S7) | — |

**Demonstrating it (staging, before live):** T-DL1–DL8 in `06-test-plan.md` — kill the function
mid-batch, run two workers at once, feed a dead token, and count deliveries per notice.

**Cost:** Expo's push service has no charge; the cron job calls the function only when a row is due,
well inside the Supabase Free allowance of 500K Edge Function invocations a month (Pro: 2M).

## 5.6 Report, block, filter and moderation (S3)

**Data (0069):**
- `reports (id, reporter_id, target_kind 'message'|'player'|'game', message_id, profile_id, match_id,
  reason, note ≤ 500, snapshot text, created_at, status 'open'|'actioned'|'dismissed', handled_by,
  handled_at, action, emailed_at)`. `snapshot` = the message text or display name at report time, so a later
  deletion does not erase the evidence. Insert only via `report_content`; read by admin only.
- `blocks (blocker_id, blocked_id)`, `block_player`, `unblock_player`. Effects in the database:
  games of either side hidden from the other's board; `join_match` → `blocked`; blocked sender's
  messages flagged for the blocker; no `match_message` notices between them. A block does not remove
  anyone from a game already shared; the app offers Leave or Remove.
- `blocked_terms` (short list, English / Arabic / French) checked by the chat trigger and the name
  check → `message_not_allowed`.
- `profiles.rules_accepted_at` (one-time community rules); `profiles.suspended_at` — when set, every
  game write and chat insert refuses with `account_suspended`.
- Admin RPCs (admin only): `admin_reports(status)`, `admin_resolve_report(id, action, note)`,
  `admin_hide_message(id)`, `admin_suspend(profile, reason)`, `admin_unsuspend(profile)`.

**Moderation process (pilot):**

| Step | Who / how |
| --- | --- |
| Receives reports | The CourtBook moderator — **Paul** during the pilot (decision P2). Each new report is emailed to `courtbook.contact@gmail.com` by `deliver` (subject "Report: message / player / game"), with the snapshot, reason and a link to the admin page |
| Reviews | Admin page "Reports" in the existing web admin area (decision P2): open reports, snapshot, surrounding messages, reporter and reported player's history (earlier reports, blocks received) |
| Target, not a promise | Checked once a day on working days during the pilot. Players are **not** told a response time; the in-app copy says reports are reviewed and acted on. Blocking is instant and self-service, so a player never waits on moderation to stop contact |
| Actions (in order of severity) | Dismiss · hide the message (`admin_hide_message`) · warning email from the support address · remove from the game (organiser can; admin via `remove_player` as admin) · suspend the account (`admin_suspend`) · delete the account (M4 account deletion) |
| Serious incidents — threats of violence, sexual content, anything involving a minor, sharing someone's private details, real-world danger | Suspend at once; keep the evidence (report snapshot, messages are not hard-deleted); tell the reporter to contact the police or emergency services if anyone is in danger; respond to lawful requests from Lebanese authorities after taking legal advice (D6 lawyer); record what was done in the report |
| Records | Every action stored on the report (`action`, `handled_by`, `handled_at`); retention follows the privacy policy draft |
| When Paul is away | Reports wait; nothing is promised to players; blocking still works. Before store submission, name a backup moderator or keep the no-promise wording |

**Store requirements covered:** filter (blocked terms), report (in app, on messages, players and
games), block (in app), published contact (Profile → Help), terms (community rules sheet, Google).

## 5.7 Notifications in the app

List: own rows (RLS), newest 50. Mark read: `mark_notifications_read(ids)` with the opened game's
unread ids. Delete: `delete_notification`, `clear_notifications`. Badge: unread count; iOS app-icon
badge via `expo-notifications`.

## 5.8 Push on the phone

`expo-notifications` adds native code → new build and `version` bump (the update workflow's
fingerprint gate enforces it). Pre-prompt in context (J10); `getExpoPushTokenAsync({ projectId })`
per variant; foreground → in-app toast (none for the chat on screen); tap → route from `kind` /
`match_id`; cold start → `getLastNotificationResponseAsync` before first navigation; Android channel
"Games"; Android 13+ runtime permission.

## 5.9 Security checklist for every new database object

- `security definer` with `set search_path = public`; `auth.uid()` checked first; revoke from
  `public, anon`; grant to `authenticated` only where the app calls it; admin RPCs check `is_admin()`.
- New tables: RLS on; no client write policy unless needed; no blanket UPDATE grant (lesson of S5).
- Every new check has a SQL test that fails when the check is removed (mutation check).
- Re-runnable migrations (suite §AL).

## 5.10 Out of M3

Organiser hand-over, invites, Realtime, read receipts, typing indicators, images in chat, coach
booking, real payments, Arabic UI (M4, release-plan D8), automatic re-booking of a lost court.
