# M3 — iPhone check (CourtBook Staging), after the iOS staging update

Two phones: **iPhone** = your own account (email code); **Samsung** = Paul Tester
(`paul.tester@courtbook.test`, the staging tester password). Report failures only, with the step number.

**0. Get the update** — on the iPhone, close CourtBook Staging completely and reopen it, twice.
Profile → About → Update shows the update ID from the publish report, Published today. (If it still
shows an older one, close and reopen once more.)

| # | Step | Expected |
| --- | --- | --- |
| 1 | iPhone: sign in with your email, type the 8-digit code | Signed in; Profile shows your name |
| 2 | Samsung: Find a game → Post a game → padel, demo club, tomorrow, Ask to join, 3 players → Post game | The game appears on the board once |
| 3 | iPhone: Find a game (Any time, padel) | Paul Tester's game is listed; opening it shows the game screen |
| 4 | iPhone: Ask to join → confirm | "Request sent" banner |
| 5 | Samsung: open the game → Accept your request | iPhone (pull to refresh): you're in the game; Activity shows the notice |
| 6 | iPhone: Chat → send "hello" (agree to the five rules if asked) | Message appears once; Samsung sees it |
| 7 | Samsung: reply "hi" | iPhone shows it within a few seconds |
| 8 | iPhone: long-press "hi" → Report message → Spam → Send report | Thanks message, with "Block this player" offered |
| 9 | iPhone: Block this player → Block | "hi" now reads "Message from a player you blocked"; the game screen says you blocked the organiser |
| 10 | iPhone: Profile → Blocked players → Unblock → Unblock | List empty; reopen the chat: "hi" shows again |
| 11 | Website preview, Admin → Reports | Your report is under Open; Dismiss it |
| 12 | Samsung: Manage game → Cancel game | Game cancelled (clean-up) |

Also note anything that looks wrong on the iPhone's screen (text cut off, keyboard covering the chat box).
