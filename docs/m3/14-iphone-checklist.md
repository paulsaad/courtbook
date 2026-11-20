# M3 — iPhone check (CourtBook Staging), short version

Published 20 Nov: iOS staging update `01a1fa3f-d178-7e65-9584-5ca350b73cf5` (group
`e1397c4b-55dd-44d1-9279-ae74f682520f`). Only what can differ on iOS is checked; the flows themselves
already passed on Android and the emulator.

Uses the **shared test game** (Paul Tester's open game, you already in it, one message from him).
The same game serves the Android block / unblock check. Blocks belong to the account, not the phone:
finish one phone (block, then unblock) before starting the other.

| # | iPhone step | Expected |
| --- | --- | --- |
| 0 | Close CourtBook Staging completely and reopen it, twice | Profile → About → Update `01a1fa3f…` |
| 1 | Sign in if asked (email, then the 8-digit code) | Signed in |
| 2 | Find a game → open "[M3 TEST] Shared game" | You're in the game |
| 3 | Chat → tap the message box, type, Send (agree to the rules if asked) | The keyboard never covers the box; the message appears once |
| 4 | Long-press "Hi! Test message…" → Report message → Spam → Send report → Block this player → Block | It now reads "Message from a player you blocked" |
| 5 | Profile → Blocked players → Unblock → Unblock; reopen the chat | The message shows again |

Report failures only, with the step number. When both phones are done, the game is removed with
`m3_test_games_cleanup` and its id.
