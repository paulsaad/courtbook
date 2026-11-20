# M3 — 3. Game rules and native user journeys

§3.0 is the single statement of the game rules. The database enforces every one of them; the UX
spec (`04-ux-spec.md`) and the tests (`06-test-plan.md`, IDs in the last column) refer to these IDs
rather than restating them. "Now" = rule in the current database; "M" = the change is in a planned
migration (`02-safety-review.md` §2.3).

Wording in the app: "game", "organiser", British spelling (as in Bookings → Games). Personas:
**Rami** organises padel at Batroun; **Nour** looks for games; **Karim** is a stranger.

## 3.0 Game rules (GR)

| ID | Rule | Enforced by | Tests |
| --- | --- | --- | --- |
| GR-1 | **States.** Stored: `open`; `closed` with reason `full`, `organizer` (shown as *Private*) or `no_court` (M, *court booking cancelled*); `cancelled` (final). Derived from time: *playing* (`start_at ≤ now < end`), *played* (after end; no end → start + 3 h, as `hide_match`) | table check, `match_detail` | T-MD1 |
| GR-2 | **Who sees a game** (`match_detail`, M): organiser and players with an accepted or pending row — always, in every state (making a game private removes pending rows, GR-4); anyone signed in — only while `open` and not started; club staff and admin — always; signed-out — never. Names of players: organiser and accepted players only (`match_participants`, now) | `match_detail`, RLS | T-MD1–MD4, T-R1–R4 |
| GR-3 | **Joining.** Only when `open` and not started; not the organiser; no declined row; not blocked (M). Open mode → accepted at once; approval mode → pending. Last place: one winner (row lock) | `join_match` | §T 51–54, C1, T-S4, T-S3d |
| GR-4 | **Waiting list.** Exists only in approval games: requests already pending when the game fills stay pending; new requests on a full game are refused (`match_closed`). Each waiting player gets one `match_full_waiting` notice per fill (M). When a place reopens nobody is promoted automatically; the organiser may accept a waiting player. Making the game private removes waiting requests with a notice (now); cancelling keeps them and notifies (now) | `decide_join`, `update_match`, `remove_player`, `set_match_status` | T-S11, T-S15 |
| GR-5 | **Decline.** Organiser declines a pending request at any time; final for that game — the player cannot request again (M fixes the bypass) | `decide_join`, `leave_match` | T-S4 |
| GR-6 | **Removal** (M). Organiser (or admin, for moderation); accepted players only (pending → decline); before start; stored as *declined* (final, as GR-5); notice `player_removed`; removed player loses chat and names immediately; a game closed as `full` reopens; a `no_court` or private game stays as it is | `remove_player` | T-RP1–RP6 |
| GR-7 | **Leaving.** Accepted or pending player, before start. Declined row is kept (M). Accepted leaver → organiser told; a `full` game reopens; other closed games stay closed | `leave_match` | §T 55, T-S4, T-CL11 |
| GR-8 | **Organiser actions and time limits.** Edit details: not cancelled, before start (now). Accept: `open`, before start, capacity (now). Decline: any time (now). Remove: GR-6. Make private / reopen: before start (M adds the time limit), not while `no_court` (M), not after cancel (now). Cancel: until the game is played (M adds the limit). Resolve a lost court: GR-9. The organiser cannot leave; to stop organising, cancel. Admin may change status (now) | `update_match`, `decide_join`, `set_match_status`, `resolve_court` | T-GR8a–e |
| GR-9 | **Court booking cancelled** (M). When a linked booking goes from `confirmed` to `cancelled` before the game is played: the game keeps its record, players and chat; `court_lost_at` is set; the link is removed; an `open` or `full` game becomes `closed`/`no_court` (joins and approvals paused); a private game stays private. Organiser, accepted and pending players are told. The organiser resolves with `resolve_court`: link another of their confirmed bookings (club, court and time follow it), or confirm the game goes ahead without a CourtBook court; or cancels. Resolution → `open` (or `full` if full; private stays private), players told (`court_resolved`). A `no_show` mark is not a cancellation and changes nothing (S18). No automatic re-booking | `sync_match_with_booking`, `resolve_court` | T-CL1–CL12 |
| GR-10 | **Games without a court** (P1 approved). Allowed when posted that way (club required, ≤ 60 days, M) or after GR-9 resolution. Card, detail and push say "No court booked through CourtBook"; joining asks for an explicit confirmation; the wording never suggests CourtBook has reserved anything | `post_match`, app | T-S10a–b, U1 |
| GR-11 | **Cancelling.** Final. Accepted and pending players told. Members can still open the game and read the chat; nobody can write (M). Members may hide it | `set_match_status`, chat trigger | §U 62, T-S9b |
| GR-12 | **Chat.** Read and write: organiser and accepted players. Pending, declined, removed, left: none. Write refused when cancelled (M), when the sender's text is blocked (M), over rate (M), before accepting the community rules (M). Timestamps set by the server (M). Own messages can be deleted (soft) | RLS, chat trigger, `delete_match_message` | T-S2, T-S9, T-S3f–h, T-R1–R4 |

---

## J1 — Find a game

**Path:** Home → "Find a game" (or Club → Games) → board.

1. Board loads `open_matches` with the saved filters (sport, date window, area, "My level").
2. Each card: sport mark, day and time, club and town, court or "No court booked through CourtBook", level range + fit,
   `PlayerSlots`, join mode ("Ask to join" / "Join straight away").
3. Pull to refresh; refetch on focus and reconnect; `Freshness` line.

| Edge case | Behaviour / message |
| --- | --- |
| Signed out | Board not loaded. `SignInPrompt`: "Sign in to find games — Games are posted by players. Sign in to see who's playing near you." Returns to the board after sign-in |
| No games for filters | "No games match these filters." + "Clear filters" + "Post a game" |
| No games at all | "No open games yet. Be the first — post one from a booking." |
| My level unset and "My level" on | Server returns all levels for players without a level (current `open_matches` rule); chip shows "Set your level to filter by it" |
| Offline | `OfflineBanner`; cached board with "Last updated 14:02"; actions disabled |
| Load fails | "Couldn't load games. Check your connection and try again." + Retry |
| A card's game fills or closes while viewing | Next refetch removes it; tapping a stale card opens detail, which shows the real state or "isn't open any more" (GR-2) |
| More than 100 games | Server returns 100; footer "Showing the next 100 games. Narrow the dates to see more." |

## J2 — Open a game

**Path:** board card · Bookings → Games row · Club → Games · notification · push · link `courtbook://match/<id>`.

1. Detail loads `match_detail(id)` (M, first migration) — the only source; never `match_board`.
2. Shows hero (sport, date, time, club, court or "No court booked through CourtBook"), status, level + fit, organiser,
   `PlayerSlots` (names for members), note, join mode, my status.
3. Opening marks this game's unread notices read (their ids), not all notices.

| State (GR-1) | Shown to members | Shown to others |
| --- | --- | --- |
| Open | Join / Ask to join (non-members) · Chat (members) | Join / Ask to join |
| Pending (me) | "Request sent — Rami will accept or decline." + Withdraw | — |
| Waiting (me pending, game full) | "The game is full. You're on the waiting list — Rami can still add you if a place opens." + Withdraw | — |
| Declined / removed (me) | (open) "Rami didn't accept you for this game." no action | (other states) not visible |
| Full | "Full · 4 of 4" | not visible → "isn't open any more" |
| Private | "Private game" | not visible |
| Court booking cancelled | Banner (warnSoft): "The court booking for this game was cancelled. Joining is paused until Rami decides." Organiser sees the resolution actions (J7) | not visible |
| Cancelled | "Cancelled by the organiser." Chat read-only; Hide | not visible |
| Playing | "Playing now." Chat open; no join, leave or remove | not visible |
| Played | "Played Sat 21 Nov." Chat open (GR-12); Hide | not visible |
| Not found / not visible | "This game isn't open any more, or isn't available to you." + Back | same |
| Signed out (link) | Sign-in prompt, then the game | — |

## J3 — Join or ask to join

1. Tap → one call `join_match(id)` (busy state, haptic on success).
2. `accepted` → "You're in." · `pending` → "Request sent."
3. Detail, board and Bookings → Games refetch.
4. Game without a court (GR-10): confirm first — "No court is booked through CourtBook for this
   game. Rami says they are arranging the court. Join anyway?"
5. Level outside the range: confirm — "This game is for levels 6–8. You're 4. Ask to join anyway?"

| Edge case | Message |
| --- | --- |
| Last place taken (`match_full`) | "This game just filled up." |
| Not open (`match_closed`) — includes court booking cancelled | From the refetched detail: court lost → "Joining is paused: the court booking was cancelled."; else "This game is no longer open." |
| Declined earlier (`join_declined`) | "Rami didn't accept you for this game." |
| Started (`match_started`) | "This game has already started." |
| Blocked either way (`blocked`, M) | "You can't join this game." |
| Too many requests (`too_many_requests`, M) | "You have many requests waiting. Withdraw one to ask for another." |
| Network lost mid-call | Re-read the game; show the real state; else "Couldn't reach CourtBook. Your request may not have been sent — check the game and try again." |
| Double tap | One call; server idempotent for pending / accepted |

## J4 — Withdraw or leave

Pending → "Withdraw request" (no confirm). Accepted → "Leave game" with confirm "Leave this game?
Rami will be told." → `leave_match` (GR-7).

| Edge case | Message |
| --- | --- |
| Started (`match_started`) | "The game has started — you can't leave it now. Message the group instead." |
| Court booking cancelled | Leaving allowed; game does not reopen |
| Cancelled meanwhile | Leave hidden; "Cancelled by the organiser." |
| Network uncertain | Re-read; show the real state |

## J5 — Organiser accepts or declines

**Path:** push / Activity "Nour asked to join" → game → Requests.

1. Requests list (pending rows): name, level for this sport, when asked.
2. Accept / Decline → `decide_join`. Accept is disabled while the game is full or the court booking is
   cancelled, with the reason shown ("Game full" / "Paused: court booking cancelled").
3. When the last place fills, the remaining requests become the waiting list (GR-4).

| Edge case | Message |
| --- | --- |
| Accept when full (`match_full`) | "The game is full. Remove a player or add a place first." |
| Request withdrawn (`not_pending`) | "That request was withdrawn." Row disappears |
| Not open (`match_closed`) | "Accepting is paused while the game isn't open." |
| Two organiser devices accept for one place | One succeeds, the other gets `match_full` (C2) |

## J6 — Post a game

**Path A (main):** Bookings → Courts → my booking → "Find players" → sheet → `post_match` with the
booking. **Path B:** Find a game → "Post a game" → club, date, time, duration → `post_match` without
a booking (GR-10). Defaults are the web's (1 player from a booking, 3 otherwise; "Join straight
away").

| Edge case | Message |
| --- | --- |
| Booking already has a live game (`booking_already_posted`) | "You already posted a game for this booking." → open it |
| Booking sport differs (`sport_mismatch`) | "That booking is for a different sport." |
| Booking not confirmed / not mine (`booking_not_found`) | "Pick one of your own upcoming bookings." |
| Time passed (`slot_in_past`) | "That time has passed." |
| Too far ahead (`too_far_ahead`, M) | "Games can be posted up to 60 days ahead." |
| Too many open games (`too_many_games`, M) | "You already have 10 open games. Close one to post another." |
| Network uncertain | Re-read (`booking_match` for path A, my agenda for B) before any retry |

## J7 — Manage a game (organiser)

**Path:** game → "Manage game" sheet. Permissions and time limits: GR-8.

| Action | Server | Confirm / message |
| --- | --- | --- |
| Edit players needed, level, note, join mode | `update_match` | Below accepted → "You already have more players accepted than that." |
| Make private | `set_match_status(closed)` | "Make this game private? It leaves the board and waiting requests are declined." |
| Open to players again | `set_match_status(open)` | Not after cancel (`cannot_reopen`); not while the court booking is cancelled (`court_lost` → "Sort out the court first.") |
| Remove a player | `remove_player` (M) | "Remove Nour from this game? They'll be told and can't ask to join it again." |
| Cancel game | `set_match_status(cancelled)` | "Cancel this game? Everyone is told. This can't be undone." The booking itself is not cancelled |
| **Court booking cancelled** (GR-9) | `resolve_court` (M) | Sheet "Your court booking was cancelled" with three choices: **Use another of my bookings** (list of own confirmed future bookings for this sport → link; "Players will be told the new time and place."); **Go ahead without a CourtBook court** ("Players will see 'No court booked through CourtBook' and be told you're arranging the court."); **Cancel the game**. No automatic booking is made |
| Booking moved by the club | trigger | Notice "Your court time changed"; game follows |
| Cancel my booking that has a game | Bookings | Warning first: "Players are in your game for this booking. If you cancel the court, joining is paused until you choose what to do." |

## J8 — Chat

**Path:** game (member, GR-12) → Chat.

1. Opens at the newest message; polls every 4 s while visible and the app is active; cursor and
   reload rules in `05-architecture.md` §5.4.
2. Send: optimistic bubble "Sending…", replaced by the server row; failure → "Not sent — tap to
   retry" (same message id, so a retry can't duplicate).
3. Long press own message → Delete. Others' → Report message · Block Nour.
4. First message ever: Community rules sheet (accept once).

| Edge case | Message |
| --- | --- |
| Removed or left while open | Next poll returns nothing → "You're no longer in this game." Composer hidden |
| Game cancelled (`match_cancelled`, M) | "This game was cancelled." Read-only |
| Too fast (`slow_down`, M) | "You're sending messages quickly. Wait a moment." |
| Blocked term (`message_not_allowed`, M) | "This message can't be sent. Check our community rules." |
| Over 1000 characters | Counter from 900; Send disabled above 1000 |
| Blocked player's messages | Collapsed: "Message from a player you blocked" |
| Report sent | "Thanks for reporting this. We review every report and act when our community rules are broken. You can also block this player now." (no response-time promise) |
| Offline | Composer disabled "You're offline"; history readable |

## J9 — Activity and unread badge

**Path:** Home bell (badge) → Activity; or Profile → Activity.

1. Newest 50 notices; unread = dot + bold text.
2. Tap → game (or booking) and marks that notice read.
3. Badge = unread count; refresh on focus, on push receipt, every 60 s in foreground; app-icon badge
   from the same count.
4. Swipe to delete (`delete_notification`); "Clear all" (`clear_notifications`).

| Edge case | Behaviour |
| --- | --- |
| Notice for a game I can't see any more | "isn't open any more, or isn't available to you" (GR-2) |
| None | "Nothing yet. Requests, replies and changes to your games show up here." |
| Badge > 99 | "99+" |

## J10 — Push notifications

1. **Permission in context, once:** after the first successful post (J6) or join / request (J3):
   pre-prompt → only "Allow" triggers the OS prompt; "Not now" asks once more after a later game
   action, never again after that.
2. Token registered (`register_push_token`, M); removed on sign-out.
3. Tap (foreground, background or killed app) → right screen, tabs underneath (Back → Home).
4. Profile → Notifications: per-group toggles (Requests and replies · Messages · Changes to my
   games) and email on/off (existing `email_notifications`).

| Edge case | Behaviour |
| --- | --- |
| Permission denied in OS | Profile → Notifications: "Turned off in Settings" + "Open Settings" |
| Staging app | Staging project and tokens only (`05-architecture.md` §5.5) |
| Two phones | Both receive; badge corrects on next refresh |
| Account switched | Old token removed before the new one registers |
| Expired token | Deleted by the sender (§5.5) |
| Push for a game I've since left | Opens the current state or "isn't open any more, or isn't available to you" |
| Same notice pushed twice (rare, §5.5) | Both open the same screen; no harm |

---

## Acceptance mapping (release plan M3)

| M3 acceptance | Journeys |
| --- | --- |
| Two accounts complete post → request → approve → chat → leave, each step visible to the other | J6, J3, J5, J8, J4, J9 |
| A non-member cannot read a chat or a participant list (RLS on staging) | GR-2, GR-12; T-R1–R4 |
| Push for each notification type opens the right screen, including from a killed app, on iOS and Android | J10; P-tests |
