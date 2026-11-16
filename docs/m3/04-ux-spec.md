# M3 — 4. UX and UI specification (Court Lines)

**Status: specification for review, not an approved design.** It applies the existing Court Lines
system (`mobile/DESIGN.md`, `mobile/lib/theme.ts`) to the M3 screens. Layouts below are structural
(order, hierarchy, states, copy); the visual design of the three new key screens goes through the
Stitch workflow and Paul's approval before code (§4.10). The approved Club Info design is untouched
and is not a template to be re-run.

## 4.1 Rules carried over unchanged

- Green (`cedar`) for every action; one primary action per area.
- Red (`red`, `#C8102E`) only as brand accent: open spots in `PlayerSlots`, unread badges, the
  selected sport outline, the active tab line. Never a status, never a button, never an error.
- Errors: `danger` with words and an icon. Pending / waiting: `warnSoft` + `warnInk`.
- Times, dates' numerals, counts and prices in scoreboard type (Archivo Narrow).
- Limestone page, white cards, hairline borders, radius 18 for cards.
- Text up to 1.6×; layouts wrap; 48 × 48 targets; every control labelled; no meaning by colour alone.
- Tabs stay **Home · Courts · Bookings · Profile** (D10: no fifth tab).

## 4.2 Navigation (from the native app plan §4, adjusted to the current app)

```
Home ─ [Find a game] ─ Board ─ Game ─ Chat
     └ bell ─ Activity ─ Game | Booking
Courts ─ Club [Book | Info | Games] ─ Game
Bookings [Courts | Games] ─ Booking ─ "Find players" sheet ─ Game
                        └ Game ─ Chat
Profile ─ Activity · Notifications · Help (contact)
```

Deep links: `courtbook://match/<id>`, `courtbook://activity` (both already reserved in the plan).
Pushed screens sit on the tab stack so Back goes to the tab, not out of the app (existing rule in
`app/_layout.tsx`).

## 4.3 Screen: Find a game (board)

Order, top to bottom:

1. Header: large title "Find a game"; right: "Post" (text button, green).
2. Sport chips (horizontal, red outline when selected; "All sports" first).
3. Filter row: date window segmented `Today | This week | Any time`; "Area" chip (governorate /
   district sheet); "My level" toggle chip (ink-filled when on). A "Filters · 2" count when any
   non-default is set, with "Clear".
4. `Freshness` line.
5. Game cards (list, 16 side margin inside list).
6. Empty / error / offline states (`StateView`).

**Game card** (new component `GameCard`):

```
┌────────────────────────────────────────┐
│ [sport mark]  SAT 21 NOV   18:00–19:30 │  date eyebrow + scoreboard time
│ Batroun Padel & Tennis · Batroun       │  strong
│ Court 2  ·  Levels 4–6  ·  Your level ✓│  secondary; fit as text + icon
│ ●● ◌◌  2 spots left                    │  PlayerSlots (red dashed = open)
│ Rami · "Friendly doubles, bring balls" │  caption, 1 line
│                         Ask to join ›  │  join mode label (not a button)
└────────────────────────────────────────┘
```

- Whole card is one button; accessibility label reads the line in order: "Padel, Saturday 21
  November, 18:00 to 19:30, Batroun Padel and Tennis, court 2, levels 4 to 6, your level, 2 of 4
  players, 2 spots left, asks to join."
- Fit wording from `levels.ts` `fitLabel` (copied to `mobile/shared/`): "Your level" (cedarDeep),
  "Above your level" / "Below your level" (warnInk on warnSoft pill), "Set your level" (muted).
- No court → "No court booked" in muted text (never red).

## 4.4 Screen: Game (detail)

1. Hero on `night` with Court Lines decoration (same treatment as the booking ticket hero): sport
   mark, day + time (scoreboard 34–40), club, court / "No court booked". Status pill under the
   time: "Open", "Full", "Private", "Court cancelled", "Playing now", "Played", "Cancelled" (white text on translucent
   white; cancelled uses words, not red).
2. Banners, in this order, only when they apply (states and wording: `03-journeys.md` J2):
   court booking cancelled (warnSoft, clock-off icon, always first) "The court booking for this game
   was cancelled. Joining is paused until Rami decides."; then my status — pending (warnSoft)
   "Request sent — Rami will accept or decline."; waiting (warnSoft) "The game is full. You're on the
   waiting list."; accepted (cedarSoft) "You're in."; declined or removed (white) "Rami didn't accept
   you for this game."
3. Primary action area (one green button): Join / Ask to join / Chat (members).
   Secondary text actions below: Withdraw request · Leave game · Directions (club address, reuse
   Club Info's map link).
4. Players: `PlayerSlots` large, then the list of names (members only; non-members see counts and
   the organiser's name only — server rule).
5. Requests (organiser only): rows with name, "Level 5 · Intermediate", "asked 2 h ago",
   Accept (green secondary) / Decline (plain). Count in the section title.
6. Details: level range, join mode, note, "Organised by Rami".
7. Organiser: "Manage game" row → sheet (§4.6). When the court booking was cancelled, a primary
   "Choose what to do" button opens the court sheet (§4.6) instead.
8. Footer: "Report this game" (non-organiser, small, muted).

## 4.5 Screen: Chat

- Title "Padel · Sat 18:00"; subtitle the club. Header right: "Game" (back to detail).
- Messages: own bubbles right on `cedarSoft` with ink text; others left on white with the sender's
  name above the first message of a run. Time in caption under the last bubble of a run.
  Day separators "Today", "Yesterday", "Sat 21 Nov".
- Deleted: italic muted "Message deleted". Blocked sender: collapsed "Message from a blocked player".
- Composer: multiline input (max 5 lines visible), counter from 900/1000, Send icon button (48,
  green, disabled when empty). States: offline ("You're offline"), not a member, cancelled, finished
  (read-only with "Delete conversation").
- Long press menu: own → Delete; others → Report message, Block player.
- New messages while scrolled up: "New messages ↓" pill (ink on white); not auto-scroll.
- Accessibility: each bubble "Nour, 18:02: running 5 minutes late"; composer labelled "Message the
  group"; announce new messages politely only when at bottom.

## 4.6 Sheets

- **Find players / Post a game:** players needed (stepper, scoreboard number, 1–30), level range
  (two steppers or "All levels welcome" switch), join mode segmented `Join straight away | Ask to
  join` with one-line explanation each, note (300, counter), path B adds club, date (`DateStrip`),
  start time, duration chips (60 / 90 / 120). Primary: "Post game". Review line above it:
  "Your game will appear on the board for players at Batroun."
- **Manage game:** Edit details · Make private / Open to players · Remove a player · Cancel game
  (last, separated, words "Cancel game" in danger colour with the confirm in J7). Items not allowed
  now (GR-8) are shown disabled with the reason, not hidden.
- **Court booking cancelled (organiser):** title "Your court booking was cancelled"; one line on
  what players see; three rows: "Use another of my bookings" (opens a list of own confirmed future
  bookings for this sport, each with club, court, day and time), "Go ahead without a CourtBook
  court", "Cancel the game" (danger). Each ends in a confirm that says who will be told.
- **Community rules (once):** five short rules + link "Terms of use"; "I agree" (green).
- **Report:** reasons (Spam · Abuse or harassment · Inappropriate · Threat or danger · Something
  else) + optional note → "Send report". Confirmation: "Thanks for reporting this. We review every
  report and act when our community rules are broken. You can also block this player now." For
  "Threat or danger": add "If anyone is in danger, contact the police or emergency services now."
  No response time is promised (moderation process: `05-architecture.md` §5.6).
- **Push permission (pre-prompt):** title "Get told when players reply?" body "We'll notify you about
  requests, messages and changes to your games. You can change this any time in Profile."
  Buttons: "Allow notifications" (green) / "Not now".

## 4.7 Activity

- Rows: kind icon, text (bold when unread + leading dot), relative time; tap target whole row.
- Kind icons (from `Icon`): request → person-plus, accepted → check, declined → x, left → door,
  cancelled → x-circle, message → chat, booking moved → clock, booking unlinked → court-off.
  Missing icons are added to `Icon.tsx` as plain strokes.
- Home header bell with red badge (count, "99+"); Profile → Activity row with the same count.

## 4.8 Messages for every server code the M3 screens can receive

Native keeps its own map (in `mobile/lib/errors.ts`), because the web map says "match" and its
`not_found` is payment-specific. Web copy is not changed.

| Code | App message |
| --- | --- |
| `not_authenticated` | (session flow — sign-in prompt) |
| `not_found` | "This game isn't open any more, or isn't available to you." |
| `forbidden` | "Only the organiser can do that." |
| `match_full` | "This game just filled up." |
| `match_closed` | "This game is no longer open." — or, when the refetched detail shows the court booking was cancelled, "Joining is paused: the court booking was cancelled." |
| `match_started` | "This game has already started." |
| `match_not_finished` | "You can delete the conversation once the game is over." |
| `join_declined` | "The organiser didn't accept your request for this game." |
| `organizer_cannot_join` | "You organise this game." |
| `not_pending` | "That request was withdrawn." |
| `cannot_reopen` | "A cancelled game can't be reopened." |
| `below_accepted` | "You already have more players accepted than that." |
| `bad_players_needed` | "Choose between 1 and 30 players." |
| `bad_level_range` / `bad_level` | "Choose a level range from 1 to 10, or All levels welcome." |
| `bad_join_mode` / `bad_range` | "Something in the game details isn't right. Check and try again." |
| `note_too_long` | "Keep the note under 300 characters." |
| `slot_in_past` | "That time has passed." |
| `booking_not_found` | "Pick one of your own upcoming bookings." |
| `booking_already_posted` | "You already posted a game for this booking." |
| `sport_mismatch` | "That booking is for a different sport." |
| new `club_required` | "Choose a club for this game." |
| new `too_far_ahead` | "Games can be posted up to 60 days ahead." |
| new `match_cancelled` | "This game was cancelled." |
| new `blocked` | "You can't join this game." |
| new `message_not_allowed` | "This message can't be sent. Check our community rules." |
| new `match_over` | "This game has already been played." |
| new `court_not_lost` | (not reachable from the app; generic message) |
| new `court_lost` | "Sort out the court first: use another booking, go ahead without one, or cancel." |
| new `account_suspended` | "Your account is suspended. Contact courtbook.contact@gmail.com." |
| new `rules_not_accepted` | (opens the Community rules sheet) |
| new `slow_down` | "You're sending messages quickly. Wait a moment." |
| new `too_many_games` | "You already have 10 open games. Close one to post another." |
| new `too_many_requests` | "You have many requests waiting. Withdraw one to ask for another." |
| network / timeout | "Couldn't reach CourtBook. Check your connection and try again." (writes: re-read first, see J3) |
| unknown | "Something went wrong. Try again." + crash report (staging only) |

## 4.9 Push and email copy (S7 rule: built from `kind`, never from chat text)

| Kind | Title | Body | Opens |
| --- | --- | --- | --- |
| `join_request` | New request | "Nour asked to join your padel game, Sat 18:00." | Game → Requests |
| `player_joined` | Player joined | "Nour joined your padel game, Sat 18:00." | Game |
| `join_accepted` | You're in | "Your padel game, Sat 18:00 at Batroun." | Game |
| `join_declined` | Request not accepted | "Your request for padel, Sat 18:00." | Game |
| `player_left` | Player left | "A player left your padel game, Sat 18:00." | Game |
| `match_cancelled` | Game cancelled | "Padel, Sat 18:00 at Batroun was cancelled." | Game |
| `match_message` | New message | "In your padel game, Sat 18:00." | Chat |
| `booking_moved` | Court time changed | "Your padel game now starts at 19:00." | Game |
| `booking_unlinked` | Court booking cancelled | "Padel, Sat 18:00: joining is paused until the organiser decides." (organiser: "Choose what to do with your padel game, Sat 18:00.") | Game |
| `court_resolved` (new) | Game update | "Your padel game, Sat 18:00 has an update about the court." | Game |
| `player_removed` (new, D3) | Removed from a game | "The organiser removed you from padel, Sat 18:00." | Game |
| `match_full_waiting` (new) | Game full | "You're on the waiting list for padel, Sat 18:00." | Game |

Names appear only where the recipient already sees them in the app (organiser seeing an applicant).
Android channel: "Games" (default importance). iOS: no time-sensitive flag.

## 4.10 Design review (Stitch) — which screens and how

Per the Stitch workflow doc, step 3 ("Find a Game, before M3 code"):

| Screen | Stitch review? | Why |
| --- | --- | --- |
| Find a game board + game card | **Yes, first** | Highest-traffic new screen; density vs readability of the card is a real hierarchy question |
| Game detail | **Yes** | Many states (open, pending, waiting, full, private, court booking cancelled, playing, played, cancelled) and two roles (player, organiser) on one screen |
| Chat | **Yes, lightweight** | Standard pattern; review only bubble hierarchy, day separators, report affordance |
| Sheets (post, manage, court booking cancelled, report, rules, push pre-prompt) | No — build from existing components | Standard forms |
| Activity | No | List of rows; same as web |

Process (unchanged): Paul runs Stitch with `mobile/DESIGN.md`, a screenshot of the web Play board
and match page, and a brief generated from §4.3–4.5; I classify each suggestion adopt / adapt /
reject with reasons; ChatGPT reviews; **Paul approves** before any code. Stitch images are
references only — never treated as approved designs and never copied into code. The Club Info
design is not re-run or altered.

Order with the first slice (`07-roadmap.md`): its non-visual half (data hooks, error map, the
`levels.ts` copy, tests) needs no design and can start once M3 is authorised; its screens start
after Paul approves the board and detail designs. That keeps the workflow's rule "design is approved
before any code is written" for everything a player sees.
