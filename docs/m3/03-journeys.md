# M3 — 3. Native user journeys

Ten journeys. Each lists the path, what the server does, the edge cases with the exact message the
app shows, and the M3 acceptance it serves. Copy follows the app's existing voice ("game",
"organiser", British spelling — as in Bookings → Games). Error codes come from the database; the
app maps each to one sentence (full table in `04-ux-spec.md` §4.8). Function names refer to the
current database; items marked **(new)** need the hardening migration (`02-safety-review.md` §2.3).

Personas: **Rami** organises padel at Batroun; **Nour** looks for games; **Karim** is a stranger.

---

## J1 — Find a game

**Path:** Home → "Find a game" (or Club → Games) → board.

1. Board loads `open_matches` with the saved filters (sport, date window, area, "My level").
2. Each card: sport mark, day and time (scoreboard numerals), club and town, court if booked, level
   range + fit ("Your level" / "Above your level" / "Set your level"), `PlayerSlots`, join mode
   ("Ask to join" / "Join straight away").
3. Pull to refresh; refetch on focus and reconnect; `Freshness` line ("Updated just now").

| Edge case | Behaviour / message |
| --- | --- |
| Signed out | Board is not shown. `SignInPrompt`: "Sign in to find games — Games are posted by players. Sign in to see who's playing near you." Returns to the board after sign-in. (Anon cannot read games: suite §Z.) |
| No games for filters | "No games match these filters." + "Clear filters" + "Post a game" |
| No games at all | "No open games yet. Be the first — post one from a booking." |
| My level unset and "My level" on | Filter chip disabled with "Set your level first" → level guide (M4 screen; until then web link) |
| Offline | `OfflineBanner`; cached board shown with "Last updated 14:02"; actions disabled |
| Load fails | `StateView` error: "Couldn't load games. Check your connection and try again." + Retry |
| A card fills while viewing | Next refetch removes it (board lists open games only). Tapping a stale card opens detail, which shows "Full" |
| > 100 results | Server caps at 100; footer "Showing the next 100 games. Narrow the dates to see more." |

## J2 — Open a game

**Path:** board card / Bookings → Games row / notification / push / deep link `courtbook://match/<id>`.

1. Detail loads `match_detail(id)` **(new)**; first slice uses `match_board(null, 60)` filtered by id
   for future games.
2. Shows: hero (sport, date, time, club, court or "No court booked yet"), level range + fit,
   organiser name, `PlayerSlots` with names visible to members, note, join mode, my status.
3. Primary action depends on state (J3–J7).
4. Opening marks this game's unread notices read (ids from the Activity cache), not all notices.

| State | What shows |
| --- | --- |
| Open, not in it | Join / Ask to join |
| Pending (me) | "Request sent — Rami will accept or decline." + Withdraw request |
| Accepted (me) | "You're in." + Chat + Leave game + Add to calendar (M3 if cheap; else later) |
| Declined (me) | "Rami didn't accept your request for this game." No action |
| Full | "Full · 4 of 4". If pending: "You're on the waiting list." (D5) |
| Private (closed by organiser) | Non-members: "This game is private." Members unchanged |
| Cancelled | "Cancelled by the organiser." Chat hidden (as web). Hide from my list |
| Under way | "Playing now." Chat open for members. No join or leave (`match_started`) |
| Finished | "Played Sat 18 Nov." Chat read-only; "Delete conversation" (hide) |
| Not visible / gone | "This game isn't available. It may have been made private or removed." + Back |
| Signed out (deep link) | Sign-in prompt, then the game |

## J3 — Join or ask to join

1. Tap Join / Ask to join → single in-flight call `join_match(id)` (button shows progress, haptic
   on success).
2. Result `accepted` → "You're in." Result `pending` → "Request sent."
3. Detail and board refetch; Bookings → Games shows the row.

| Edge case | Message |
| --- | --- |
| Last place taken by someone else (`match_full`) | "This game just filled up." Detail refetches |
| Closed meanwhile (`match_closed`) | "This game is no longer open." |
| Declined earlier (`join_declined`) | "Rami didn't accept your request for this game." |
| Organiser (`organizer_cannot_join`) | Not reachable (button hidden); copy "You organise this game." |
| Started (`match_started`) | "This game has already started." |
| Blocked either way (`blocked`, new) | "You can't join this game." (neutral, reveals nothing) |
| Too many requests (`too_many_requests`, new) | "You have many requests waiting. Withdraw one to ask for another." |
| Network lost mid-call | Re-read the game: if my status changed, show it; else "Couldn't reach CourtBook. Your request may not have been sent — check the game and try again." (same "uncertain" rule as reservations) |
| Double tap | One call (single in-flight); server is idempotent for pending/accepted |
| Level outside range | Allowed; confirm sheet "This game is for levels 6–8. You're 4. Ask to join anyway?" |

## J4 — Withdraw or leave

1. Pending → "Withdraw request" (no confirm). Accepted → "Leave game" with confirm: "Leave this
   game? Rami will be told." → `leave_match`.
2. Accepted leaver: organiser gets `player_left`; a game closed as full reopens.

| Edge case | Message |
| --- | --- |
| Started (`match_started`) | "The game has started — you can't leave it now. Message the group instead." |
| Declined | No leave button (S4 fix keeps the decline) |
| Game cancelled meanwhile | Leave hidden; "Cancelled by the organiser." |
| Network uncertain | Re-read; show the true state |

## J5 — Organiser accepts or declines

**Path:** push / Activity "Nour asked to join" → game → Requests section.

1. Requests list (`match_participants` pending rows) with name, level for this sport, time asked.
2. Accept / Decline per row → `decide_join(id, player, accept)`. Haptic; row moves to Players.
3. When the last place is filled: "Game full." Remaining requests stay as waiting list (D5) with
   one notice each.

| Edge case | Message |
| --- | --- |
| Accept when full (`match_full`) | "The game is full. Make room or increase players needed first." |
| Request withdrawn meanwhile (`not_pending`) | "Nour withdrew the request." Row disappears |
| Game cancelled (`match_closed`) | "This game is no longer open." |
| Two organiser devices accept different players for one place | Row lock: one succeeds, other gets `match_full` (control C2) |

## J6 — Post a game

**Path A (recommended main path):** Bookings → Courts → my booking → "Find players" →
sheet: players needed (1–30), level range or "All levels", join mode, note (≤ 300) → `post_match`
with `p_booking`. Time, club and court come from the booking. Defaults are the web's (players 1
from a booking, 3 otherwise; "Join straight away"), so both clients behave the same.

**Path B:** Find a game → "Post a game" → pick club, date, time, duration (90 default), then the
same fields → `post_match` without booking. Card shows "No court booked yet".

| Edge case | Message |
| --- | --- |
| Booking already has a live game (`booking_already_posted`) | "You already posted a game for this booking." → open it |
| Booking sport differs (`sport_mismatch`) | "That booking is for a different sport." |
| Booking not confirmed / not mine (`booking_not_found`) | "Pick one of your own upcoming bookings." |
| Time passed (`slot_in_past`) | "That time has passed." |
| No club (path B, `club_required`, new) | Not reachable (club is required in the form) |
| Too far (`too_far_ahead`, new) | "Games can be posted up to 60 days ahead." |
| Bad range / count / note | Prevented in the form; server copy as fallback |
| Too many open games (`too_many_games`, new) | "You already have 10 open games. Close one to post another." |
| Network uncertain | Re-read `booking_match(booking)` (path A) or my agenda (path B) before retrying |

## J7 — Manage a game (organiser)

**Path:** game → "Manage" sheet.

| Action | Server | Notes and messages |
| --- | --- | --- |
| Edit players needed / level / note / join mode | `update_match` | Below accepted → "You already have more accepted players than that." |
| Make private | `set_match_status(closed)` | Confirm: "Make this game private? It leaves the board and pending requests are declined." |
| Open to players again | `set_match_status(open)` | Not after cancel: "A cancelled game can't be reopened." (`cannot_reopen`) |
| Cancel game | `set_match_status(cancelled)` | Confirm: "Cancel this game? Everyone is told. This can't be undone." Booking itself is not cancelled |
| Remove a player (new, D3) | `remove_player` | Confirm: "Remove Nour from this game? They'll be told." Not after start |
| Booking moved by the club | trigger | Notice "Your court moved to 19:00"; game follows |
| Booking cancelled | trigger | Game stays, "No court booked yet" + notice; organiser chooses cancel or keep (D6) |
| Cancel booking that has a game | Bookings | Warning before cancelling the booking: "Players are in your game for this booking. Cancelling the court leaves the game without a court." |

## J8 — Chat

**Path:** game (member) → Chat.

1. Opens at the newest message; polls `match_messages_list(id, p_after)` every 4 s while visible and
   foregrounded, 0 when backgrounded; full reload on open.
2. Send: optimistic bubble "Sending…"; on success replaced by server row; on failure "Not sent —
   tap to retry". One in-flight send per message (client id prevents duplicates).
3. Long press own message → Delete (soft: "Message deleted"). Long press others' → Report message ·
   Block Nour.
4. First message ever: Community rules sheet (accept once).

| Edge case | Message |
| --- | --- |
| Removed or left while chat open | Next poll returns nothing/forbidden → "You're no longer in this game." Composer hidden |
| Game cancelled | Composer replaced by "This game was cancelled." (`match_cancelled`, new) |
| Too fast (`slow_down`, new) | "You're sending messages quickly. Wait a moment." |
| Blocked word (`message_not_allowed`, new) | "This message can't be sent. Check our community rules." |
| Over 1000 characters | Counter from 900; send disabled above 1000 |
| Blocked user's messages | Hidden: "Message from a blocked player" (collapsed) |
| Offline | Composer disabled with "You're offline"; history still readable |

## J9 — Activity and unread badge

**Path:** Home bell (badge) → Activity; or Profile → Activity.

1. List of notices (newest first, 50), unread marked with a dot + bold text (not colour alone).
2. Tap → the game (or booking for booking kinds) and marks that notice read.
3. Badge: count of unread notices, refreshed on focus, on push receipt and every 60 s in
   foreground; app-icon badge set from the same count.
4. Swipe to delete (`delete_notification`); "Clear all" (`clear_notifications`).

| Edge case | Behaviour |
| --- | --- |
| Notice for a game I can't see any more | Opens the "isn't available" state (J2) |
| 0 notices | "Nothing yet. Requests, replies and changes to your games show up here." |
| Badge > 99 | "99+" |

## J10 — Push notifications

1. **Permission in context, once:** after the first successful post (J6) or first join/request (J3):
   sheet "Get told when players reply? We'll notify you about requests, messages and changes to
   your games." → Allow / Not now. Only "Allow" triggers the OS prompt. "Not now" asks again after
   the next game action at most once more.
2. Token registered with `register_push_token(token, platform, app_variant)` **(new)**; removed on
   sign-out (`unregister_push_token`).
3. Tap a push (foreground, background or killed) → opens the right screen (`match/<id>` or
   `activity`), with the tabs underneath so Back returns to Home (existing `_layout.tsx` rule).
4. Profile → Notifications: per-kind toggles (Requests and replies · Messages · Changes to my
   games) and email on/off (existing `email_notifications`).

| Edge case | Behaviour |
| --- | --- |
| Permission denied in OS | Profile → Notifications shows "Turned off in Settings" + "Open Settings" |
| Staging app | Uses the staging Expo project and only staging tokens; never live |
| Signed in on two phones | Both receive; reading on one clears the badge on the other at next refresh |
| Account switched | Old account's token deleted before the new one registers |
| Expo says token invalid (`DeviceNotRegistered`) | Sender deletes it |
| Push arrives for a game I've since left | Opens the "isn't available" or current state |

---

## Acceptance mapping (release plan M3)

| M3 acceptance | Journeys |
| --- | --- |
| Two accounts complete post → request → approve → chat → leave, each step visible to the other | J6, J3, J5, J8, J4 (+J9 for "visible") |
| A non-member cannot read a chat or a participant list (RLS on staging) | J2, J8; tests T-R1–R4 |
| Push for each notification type opens the right screen, including from a killed app, on iOS and Android | J10; tests P-1–P-6 |
