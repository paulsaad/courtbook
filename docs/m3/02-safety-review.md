# M3 — 2. Safety and security review

Scope: everything Find a Game touches — `matches`, `match_players`, `match_messages`,
`match_hidden`, `notifications`, `player_levels`, `profiles` (names), the match RPCs, the
booking ↔ game trigger, the email route; and what native push and chat add.

Method: function bodies, policies and grants read from the local replica built from the 66
migrations; each suspected defect turned into a script that runs as real `authenticated` users
(`set role authenticated` + JWT `sub`), never as the table owner. Script:
`docs/m3/repro/m3_findings.sh` (refuses any database except `courtbook_test`). Run 16 Nov 2026;
output quoted below is from that run. **Nothing was run against live or staging.** Live has the
same schema, so every REPRODUCED item is also present on live today.

Severity:
- **High** — lets one user damage other users' data or experience, or blocks store release.
- **Medium** — abuse or breakage that needs a deliberate act, or blocks a planned M3 design.
- **Low** — narrow, self-limited, or a rule enforced only in the web UI.
- **Info** — behaviour to define, no defect.

## 2.1 Summary

| ID | Finding | Object | Severity | Status |
| --- | --- | --- | --- | --- |
| S1 | Organiser can delete a game row directly; players, chat and notices vanish, nobody is told | policy `matches: organizer delete` | **High** | Reproduced (F3) |
| S2 | Chat `created_at` is chosen by the sender; breaks ordering and incremental polling | table `match_messages` (insert policy, no trigger) | **High** for M3 (blocks the chat design) | Reproduced (F2) |
| S3 | No way to report a message or a player, or to block one | — | **High** before store submission | By inspection |
| S4 | A declined player can leave and request again, without limit | `leave_match` | **Medium** | Reproduced (F1) |
| S5 | A user can rewrite their notifications and put them back in the email queue | table grant `UPDATE` on all columns of `notifications` | **Medium** | Reproduced (F9) |
| S6 | No read path for a game once it starts (or > 60 days ahead); web page 404s, chat unreachable | `match_board` (only single-game read) | **Medium** (functional; blocks native detail) | Reproduced (F7) |
| S7 | Push would put chat text and names on the lock screen | `match_message_notify` body = `name: first 80 chars` | **Medium** (design rule for G3) | By inspection |
| S8 | Pending requesters are not told when the linked booking is moved or cancelled | `sync_match_with_booking` | **Low** | Reproduced (F4) |
| S9 | Chat insert: a row inserted as "deleted" skips the 1–1000 length check; messages accepted on cancelled games (web hides the box, database does not) | `match_messages` check + insert policy | **Low** | Reproduced (F8) |
| S10 | A game without a booking needs no club and has no date limit; club-less games never appear anywhere | `post_match` | **Low** | Reproduced (F6) |
| S11 | Game fills through approvals; other requests stay pending forever, no notice | `decide_join`, `join_match` | **Info** (define) | Reproduced (F5) |
| S12 | No rate limits on posting games, requests, messages | all write RPCs | **Low** (pilot) | By inspection |
| S13 | Display names unbounded and free text (length, "CourtBook", lookalikes) | `profiles.name` | **Low** | By inspection |
| S14 | A hidden game still creates message notices | `match_message_notify` | **Low** | By inspection |
| S15 | Switching approval → open leaves earlier requests pending while newcomers get in directly | `update_match` | **Low** | By inspection |
| S16 | Native cannot trigger email fan-out (route accepts the web cookie only) | `/api/notify/email` | **Info** (architecture) | By inspection |
| S17 | Web marks *all* notices read when any game is opened | `src/app/matches/[id]/page.tsx:28` | **Info** — leave web as is; native does it per game | By inspection |

**Controls verified (no defect):**

| ID | Property | Result (16 Nov run) |
| --- | --- | --- |
| C1 | Two players take the last place at once | 1 accepted, the other gets `match_closed` (row lock in `join_match`) |
| C2 | Organiser accepts while a player joins the last place | 1 accepted |
| C3 | Outsider cannot read participants or chat; anon sees no games or names | Existing suite §T 55, §U 61, §Z |
| C4 | No client can create notifications (`notify` not executable; no insert policy) | Existing grants; §U |
| C5 | `player_names` returns names only to co-members and club staff | §H 27 |
| C6 | Organiser cannot join their own game; one live game per booking | §T 51, §W 70 |

## 2.2 Findings in detail

### S1 — Organiser deletes a game directly · High

- **Object:** RLS policy `"matches: organizer delete"` — `FOR DELETE USING (organizer_id = auth.uid() OR is_admin())`;
  `authenticated` holds table-level DELETE (Supabase default). Cascades remove `match_players`,
  `match_messages`, notices.
- **Reproduction (F3):** organiser posts, player joins, organiser runs
  `delete from matches where id = …` through the API.
  Output: `rows deleted by organizer: 1; participants left: 0; 'match cancelled' notices to Adam: 0`.
- **Impact:** players lose the game from their agenda without a notice; chat history — the evidence
  a report would need (S3) — is erased by the person who might be reported. Bypasses
  `set_match_status` (cancel notices, "cancel is final").
- **Correction:** `drop policy "matches: organizer delete" on matches;`
  `revoke delete on matches from anon, authenticated;`. Cancelling stays the only way to end a game.
  Admin clean-up, if ever needed, through the service role. **Web impact: none** — no web or app
  code deletes from `matches` (checked: `grep from("matches")` → no delete).
- **Settled by:** T-S1 in `06-test-plan.md`.

### S2 — Sender chooses the chat timestamp · High for M3

- **Object:** `match_messages` — insert policy checks only `profile_id = auth.uid() AND is_match_member(match_id)`;
  `created_at` has a default but nothing forces it.
- **Reproduction (F2):** member inserts `created_at = '2030-01-01'`.
  Output: stored `2030-01-01`; the organiser's newest message is "from the future"; a client polling
  with `p_after` = newest seen gets nothing new until 2030.
- **Impact:** a member can pin a message to the bottom, reorder the conversation, and stop every
  incremental reader. The native chat plan (poll with `p_after`) cannot ship on top of this. The web
  is unaffected only because it refetches the whole list every 5 s.
- **Correction:** `BEFORE INSERT` trigger on `match_messages`:
  `new.created_at := clock_timestamp(); new.deleted_at := null;` plus the checks in S9. Keeps the
  web's direct insert working unchanged (it never sends either column).
  Incremental reads then use an overlapping cursor with de-duplication by id
  (`05-architecture.md` §5.4).
- **Settled by:** T-S2.

### S3 — No report or block · High before store submission

- **Object:** none exists. Chat and display names are user-generated content.
- **Requirement (checked 16 Nov 2026):** Apple App Review Guideline 1.2 — apps with user-generated
  content must include a filter for objectionable material, a way to report offensive content with
  timely responses, the ability to block abusive users, and published contact information
  (developer.apple.com/app-store/review/guidelines). Google Play User Generated Content policy —
  clear terms of use, an in-app system to report content and users, and a block function where users
  interact one to one (support.google.com/googleplay/android-developer/answer/9876937). Neither
  store will accept chat without these.
- **Correction (spec, `05-architecture.md` §5.6):**
  - Filter: a short server-side list of blocked terms (English, Arabic, French), checked in the chat
    insert trigger and on display names → `message_not_allowed`. Deliberately small; reports
    catch the rest.
  - Terms: the first message a user sends is preceded by a one-time "Community rules" sheet with a
    link to the terms (drafts exist: release-plan D6); acceptance stored on the profile.
  - Contact: Profile → Help shows `courtbook.contact@gmail.com`.
  - `reports (id, reporter_id, kind 'message'|'player'|'match', target ids, reason, note, created_at, status)`;
    RPC `report_content(...)` — reporter must be able to see the target; one open report per
    reporter per target; admin-only read.
  - `blocks (blocker_id, blocked_id)`; RPCs `block_player`, `unblock_player`.
    Effects: blocked player's messages are hidden from the blocker (`match_messages_list` filters);
    neither sees the other's open games on the board; `join_match` refuses
    when either has blocked the other (`blocked`), with neutral copy.
  - Report confirmation tells the reporter what happens next; reports go to the support address
    `courtbook.contact@gmail.com` (daily check) until an admin page exists.
  - The S1 fix is a precondition (chat must not be deletable by the organiser).
- **Settled by:** T-S3a–e and native journey J8.

### S4 — Decline bypass · Medium

- **Object:** `leave_match` deletes the caller's row whatever its status.
- **Reproduction (F1):** organiser declines Adam; Adam's `join_match` → `join_declined`; Adam calls
  `leave_match`, then `join_match` → `pending`. Organiser's join-request notices from Adam: 2.
- **Impact:** a declined player can re-request without limit; each request is a notice, an email
  and — with M3 — a push. Harassment channel.
- **Correction:** in `leave_match`, `if was = 'declined' then return; end if;` (no-op, row kept).
  Optional: `decide_join` lets the organiser undo a decline (out of scope).
- **Settled by:** T-S4.

### S5 — Notifications rewritable and re-queueable · Medium

- **Object:** `authenticated` holds UPDATE on every column of `notifications`
  (`information_schema.column_privileges`), and the policy `"notifications: own mark read"` only
  pins `profile_id`.
- **Reproduction (F9):** user sets `body`, `kind`, `emailed_at = null`, `email_claimed_at = null` on an
  already-emailed notice; `claim_notifications_to_email` picks it again. Output:
  `'anything | Any text the user chooses'; picked again by the email claim: 1`.
- **Impact:** recipient is always the user (pinned), so no third party receives the text; but a loop
  of update + `POST /api/notify/email` spends the shared Gmail sending quota and sender reputation
  for everyone. With push (G3) the same loop would send pushes. Also lets a user mark emails as
  sent to suppress them (harmless).
- **Correction:** `revoke update on notifications from authenticated;`
  `grant update (read_at) on notifications to authenticated;`. **Web impact: none** — the web marks
  read only through `mark_notifications_read` (security definer); checked `src/`.
- **Settled by:** T-S5.

### S6 — No read path once a game starts · Medium (functional)

- **Object:** `match_board` filters `start_at > now()` and `< now() + p_days`; it is the only
  function returning a game's card (club, court, counts, my status). Direct `select` on `matches`
  works under RLS but has no club name, court or counts.
- **Reproduction (F7):** game started 30 min ago, Adam accepted: `match_board` rows 0; RLS read 1.
- **Impact:** web `/matches/[id]` 404s from start time (its `finished` branch and "Delete
  conversation" are unreachable); the chat for a game in progress — when players most need "running
  late" — cannot be opened. Same for games > 60 days ahead.
- **Correction:** new read-only `match_detail(p_match uuid)` (security definer, stable) returning
  the `match_board` columns plus `club_timezone`, `finished`, `hidden`; visible when the caller is
  the organiser, has any row in `match_players`, the game is open, or the caller is staff/admin —
  the same rule as the `matches` read policy. Anon gets nothing.
- **Settled by:** T-S6a–d.

### S7 — Push content on the lock screen · Medium (design rule)

- **Object:** `match_message_notify` writes `body = '<name>: <first 80 chars>'`; other kinds name the
  actor.
- **Risk:** a push using `notifications.body` puts private chat text on a lock screen and in
  notification history; a renamed profile (S13) controls the title.
- **Rule for G3:** push text is built by the sender from `kind` with fixed copy
  (`"New message in your padel game, Sat 18:00"`), never from `body`; names only for kinds where
  the recipient already sees the name in the app (join request to the organiser). Data payload
  carries `notification_id`, `kind`, `match_id` only. Exact copy in `04-ux-spec.md` §4.9.
- **Settled by:** T-P3 (sender unit tests on payload construction).

### S8 — Pending players not told the court moved or vanished · Low

- **Object:** `sync_match_with_booking` notifies organiser and *accepted* players.
- **Reproduction (F4):** booking cancelled; notices: accepted 1, pending 0; game stays open with no
  booking.
- **Correction:** include `status in ('accepted','pending')` in the recipient set for
  `booking_moved` and `booking_unlinked`.
- **Settled by:** T-S8.

### S9 — Chat insert rules only the web enforces · Low

- **Object:** check `deleted_at IS NOT NULL OR length(body) between 1 and 1000`; insert policy
  ignores game status.
- **Reproduction (F8):** member inserts a 200 000-character body with `deleted_at = now()` → stored;
  message on a cancelled game → accepted, and the organiser gets a `match_message` notice.
- **Correction:** the S2 trigger also forces `deleted_at := null` (so the length check always
  applies) and raises `match_cancelled` when the game is cancelled. Project rule: never rely on UI
  checks alone.
- **Settled by:** T-S9.

### S10 — Games without a club or date limit · Low

- **Object:** `post_match` without `p_booking`: `p_club` may be null; `p_start` only needs to be in
  the future.
- **Reproduction (F6):** club-less game created; visible on `open_matches` to a stranger: 0.
- **Correction:** without a booking, require `p_club` (`club_required`) and
  `p_start < now() + interval '60 days'` (`too_far_ahead`), matching the board horizon. The web form
  always sends a club, so web behaviour is unchanged.
- **Settled by:** T-S10.

### S11 — Requests left pending on a full game · Info

- **Reproduction (F5):** Bana requested; organiser accepted others until full; Bana: `pending`, no
  notice. If a place reopens the organiser can still accept her.
- **Recommended default (D5):** keep pending as the waiting list; when a game becomes full, each
  pending requester gets one `match_full_waiting` notice ("The game is full. You're on the waiting
  list; the organiser can still add you if a place opens."). The board shows "Waiting list" for
  them. Cancel and make-private already clear requests with a notice.
- **Settled by:** T-S11.

### S12 — No rate limits · Low (pilot)

- **Gap:** unlimited posts, requests and messages per user. With push, volume becomes a cost.
- **Correction (M3, simple counters inside the RPCs/trigger):** ≤ 10 open future games per
  organiser; ≤ 20 pending requests per player; ≤ 30 messages per user per game per 10 minutes.
  Codes `too_many_games`, `too_many_requests`, `slow_down`.
- **Settled by:** T-S12.

### S13 — Display names · Low

- **Gap:** `profiles.name` has no length or content rule; it is shown in chat, notices, emails and
  (if allowed) push.
- **Correction:** check `char_length(name) <= 60` (verify existing data first); reserve "CourtBook"
  (case-insensitive) for staff accounts. Copy-level only; out of the hardening migration if any
  existing name breaks it.
- **Settled by:** T-S13.

### S14 — Hidden games still notify · Low

- **Correction:** `match_message_notify` skips recipients with a `match_hidden` row.
- **Settled by:** T-S14.

### S15 — Approval → open leaves earlier requests pending · Low

- **Correction:** when `update_match` switches `join_mode` to `open`, accept pending requests in
  request order up to capacity (with `join_accepted` notices); the rest follow S11.
- **Settled by:** T-S15.

### S16 — Email from native actions · Info

The web triggers email after an action by calling `/api/notify/email` with its cookie. The app has
none. Options: (a) G1 `authenticateRequest()` on that route (exists on `payments-g1`); (b) a
server-side dispatcher fired by the database (webhook → Edge Function) that sends push and email
for every new notice, whoever caused it. **Recommendation: (b)** — it makes delivery independent of
the client, covers trigger-created notices (booking moved/unlinked) that today are emailed only when
someone happens to call the route, and is where push must live anyway. Details in
`05-architecture.md` §5.5.

### S17 — Web marks all notices read · Info

Kept as is (web is production; not part of M3). Native marks only the opened game's notices read.

## 2.3 Hardening migration — one change set, staging first

Proposed as one migration (number assigned when written, after Paul's approval):

| Item | Fixes |
| --- | --- |
| Drop organiser DELETE policy; revoke DELETE on `matches` | S1 |
| `match_messages` BEFORE INSERT trigger: server time, `deleted_at` null, game not cancelled, rate limit | S2, S9, S12 |
| `leave_match`: declined row kept | S4 |
| `notifications`: UPDATE only on `read_at` | S5 |
| `match_detail(p_match)` | S6 |
| `sync_match_with_booking`: pending recipients too | S8 |
| `post_match`: club required and 60-day horizon without a booking | S10 |
| `match_full_waiting` notice | S11 (if D5 = recommended) |
| Counters in `post_match` / `join_match` | S12 |
| `match_message_notify` skips hidden | S14 |
| `update_match` approval → open | S15 |
| `remove_player(p_match, p_player)` | A11 (D3) |
| `reports`, `blocks` + RPCs | S3 |
| `push_tokens`, `notification_prefs` | G3 |

Web compatibility: every item keeps the existing function signatures and the direct chat insert;
the only new refusals the web can meet are `match_cancelled` (not reachable from its UI),
`club_required` (its form always sends one), `too_far_ahead` (its date picker — to be checked when
the migration is written), and the rate limits. Each will be listed with its web copy before the
migration is applied anywhere.

## 2.4 Not changed by this review

No migration was written or applied. No function, policy or grant was changed on any database.
The replica `courtbook_test` was used for the reproductions only.
