# M3 — 5. Engineering architecture

Principle: same as M1/M2 — the app talks to Supabase through the existing functions; the database
enforces every rule; the app adds no server of its own except the delivery function in §5.5. No new
paid tool. Nothing here changes the payment model or booking safety.

## 5.1 Layers

| Layer | Choice | Reuses |
| --- | --- | --- |
| Screens | `app/games/index.tsx` (board), `app/match/[id].tsx` (detail), `app/match/[id]/chat.tsx`, `app/activity.tsx`; Club page gains a `Games` segment; Bookings → Games rows become tappable | expo-router stack + tabs, `_layout.tsx` back rule |
| Data | `lib/games.ts` (queries + mutations), `lib/chat.ts`, `lib/activity.ts`, `lib/push.ts` | TanStack Query patterns from `lib/queries.ts`, `lib/bookings.ts` |
| Shared logic | `mobile/shared/levels.ts` (byte copy of `src/lib/levels.ts`; CI equality check covers it) | `shared/types.ts`, `shared/time.ts` |
| Errors | `lib/errors.ts` gains the game copy map (§4.8 of the UX spec) | `classify()` network / auth / refused / unknown |
| Components | `GameCard`, `RequestRow`, `ChatBubble`, `Composer`, `ActivityRow`, `Badge`, `Stepper`, `ReportSheet` | `PlayerSlots`, `Chip`, `Segmented`, `DateStrip`, `SportMark`, `StateView`, `Freshness`, `OfflineBanner`, `SignInPrompt`, `Button`, `Text`, `Icon` |
| Database | Existing RPCs + the hardening migration (§2.3 of the safety review) | — |
| Delivery | Database Webhook on `notifications` INSERT → Edge Function `deliver` → Expo Push API + email | `claim_notifications_to_email` logic |

## 5.2 Query keys and refresh

| Key | Source | Stale time | Refetch |
| --- | --- | --- | --- |
| `["games", filters]` | `open_matches` | 15 s | focus, reconnect, pull |
| `["club-games", clubId]` | `match_board(clubId, 14)` | 15 s | focus, reconnect |
| `["game", id]` | `match_detail(id)` (slice 1: `match_board(null,60)` filtered) | 5 s | focus, reconnect, after any mutation on `id` |
| `["game-people", id]` | `match_participants(id)` | 5 s | with `["game", id]` |
| `["chat", id]` | `match_messages_list(id, cursor)` | — | interval 4 s while screen focused and app active |
| `["activity"]` | `notifications` select (own, 50, newest) | 30 s | focus, push receipt, 60 s interval in foreground |
| `["unread"]` | `notifications` count where `read_at is null` | 30 s | as above |
| `["agenda"]` | `my_agenda` (existing) | existing | invalidated by every game mutation |

Mutations (`join`, `leave`, `decide`, `post`, `update`, `setStatus`, `remove`, `send`, `delete`,
`hide`, `report`, `block`) invalidate `["game", id]`, `["game-people", id]`, `["games"]`,
`["agenda"]`, `["activity"]` as relevant. No optimistic state for membership changes — the server's
answer is shown (same discipline as reservations); chat sends are optimistic with a local id.

## 5.3 Write safety (same rules as reservations)

- **One call in flight per action** (button busy state ignores taps).
- **Uncertain outcome** (network error or timeout after the request left): never retry blindly;
  re-read `["game", id]` and show the true state. Join, leave, decide are idempotent or
  state-checked server-side, so a later deliberate retry is safe.
- **Chat send idempotency:** client generates a UUID per message and inserts it as `id`; a retry
  of the same message hits the primary key (`23505`) and is treated as success after a re-read.
  The S2 trigger keeps `created_at` server-side; `id` stays client-chosen (harmless: random UUID,
  PK-unique, RLS-pinned to the sender).
- **Never** compute membership, capacity or level fit for a decision on the phone; fit is display
  only.

## 5.4 Chat transport

- Polling, not Realtime (D7): 4 s while the chat is visible and the app is active; paused in
  background; immediate fetch on focus and after send.
- Incremental read after S2: `match_messages_list(p_match, p_after)` returns rows with
  `created_at > p_after`, ordered by `created_at` only. Two gaps follow from that: equal timestamps,
  and a message stamped earlier but committed after a newer one was already read. So the client asks
  with `p_after = newest seen − 10 s` (overlap) and de-duplicates by `id`; it also re-fetches the full
  list every 60 s to pick up deletions (a soft delete changes an old row, which `p_after` does not
  return). No server change needed for this.
- Cost at pilot scale: one small RPC per open chat per 4 s; no extra service.
- Realtime can replace polling later without changing the screen (same hook interface).

## 5.5 Delivery: push and email (G3)

```
notifications INSERT ──(Database Webhook, async via pg_net)──► Edge Function `deliver`
     │                                                           │ service role
     │                                                           ├─ load notice + match context
     │                                                           ├─ prefs + push_tokens for profile
     │                                                           ├─ Expo Push API (fixed copy by kind)
     │                                                           ├─ email if opted in (SMTP, existing env)
     │                                                           └─ stamp pushed_at / emailed_at
     └─ the web's /api/notify/email keeps working unchanged (claim + stamp make both safe together)
```

- **Why the database triggers it:** every notice gets delivered whoever caused it — app, web, or a
  trigger such as a staff booking move (today those are emailed only when someone happens to call
  the route). No client is trusted to say "send now". Resolves S16 without G1.
- **Tables (new):** `push_tokens (profile_id, token, platform, app_variant, created_at, last_seen_at,
  unique(token))`, RLS own rows; RPCs `register_push_token`, `unregister_push_token`.
  `notification_prefs (profile_id, kind_group, push boolean)` with defaults on; email keeps
  `profiles.email_notifications`. `notifications.pushed_at`, `push_claimed_at`.
- **Claim discipline:** the function claims the row (`push_claimed_at`, 5-minute lease, `skip locked`)
  exactly like `claim_notifications_to_email`, so duplicate webhook deliveries send once.
- **Copy:** built from `kind` + match context (`04-ux-spec.md` §4.9), never `notifications.body`
  (S7). Payload data: `{ notification_id, kind, match_id }`.
- **Staging / live isolation:** the function is deployed per project; staging tokens are registered
  only by the staging app (bundle id → project, as today); the Expo access token is a per-project
  secret. Live delivery stays **off** until Paul approves (same rule as live crash reporting).
- **Receipts:** a scheduled function (every 15 min) reads Expo push receipts and deletes tokens
  reported `DeviceNotRegistered`.
- **Credentials:** FCM v1 service account (Android) and APNs key (iOS) uploaded to EAS credentials;
  never in the repository.
- **Cost:** Expo's push service has no charge; Supabase Edge Functions include 500K invocations a month on the Free plan and 2 million on Pro, far above pilot volume.
  No new paid tool.

## 5.6 Report, block, filter (S3)

- `reports`: `id, reporter_id, target_kind ('message','player','match'), message_id, profile_id,
  match_id, reason, note (≤ 500), created_at, status ('open','actioned','dismissed')`. RLS: insert via
  RPC only; select admin only. `report_content(...)` checks the reporter can see the target
  (`is_match_member` for messages; shared game or visible open game for players), one open report
  per reporter per target. A notice row for admins is not created; a `deliver`-like path emails the
  support address.
- `blocks (blocker_id, blocked_id, created_at, primary key both)`. RLS own rows; RPCs
  `block_player`, `unblock_player`. Enforcement in the database: `open_matches` / `match_board` hide
  games organised by someone I blocked or who blocked me; `join_match` raises `blocked`;
  `match_messages_list` marks rows from players I blocked (`blocked boolean`) so the client
  collapses them; `match_message_notify` skips recipients who blocked the sender. A block does not
  remove anyone from a game already shared; the app suggests "Leave game" or "Remove player".
- Blocked-terms filter: a small `blocked_terms` table read by the chat trigger and the profile name
  check (`message_not_allowed`).
- Community rules accepted: `profiles.rules_accepted_at` (set by RPC); the chat trigger requires it.

## 5.7 Notifications in the app

- List: direct select on own rows (RLS) — 50 newest. Mark read: `mark_notifications_read(ids)`
  with the ids of the opened game's unread notices (not `null`). Delete: `delete_notification`,
  `clear_notifications`.
- Badge: unread count; `expo-notifications` `setBadgeCountAsync` on iOS; Android launcher badges
  follow the OS.

## 5.8 Push on the phone

- `expo-notifications` (adds native code → new build, `version` bump per the runtime rule; the
  update workflow's fingerprint gate enforces it).
- Permission pre-prompt in context (J10); `getExpoPushTokenAsync({ projectId })` per variant.
- Handlers: foreground → in-app toast (no system banner for the chat currently open);
  tap → `router.push` from `data.kind` / `match_id`; cold start → `getLastNotificationResponseAsync`
  before the first navigation.
- Android channel "Games"; Android 13+ runtime permission.

## 5.9 Security checklist for every new database object

- `security definer` functions: `set search_path = public`, `auth.uid()` checked first, revoke
  from `public, anon`, grant to `authenticated` only where the app calls it.
- New tables: RLS on, no client write policy unless needed, grants reviewed (no blanket UPDATE —
  lesson from S5).
- Every new check has a SQL test that fails when the check is removed (mutation check, as in M2).
- Migration re-runnable (suite §AL rule).

## 5.10 What stays out of M3

Organiser hand-over, invites, Realtime, read receipts, typing indicators, images in chat, coach
booking, real payments, Arabic UI (M4, release-plan D8).
