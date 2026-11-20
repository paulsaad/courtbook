# M3 — staging website check (browser) — DONE 20 Nov

**Result:** A1–A5 PASS and B1–B2 PASS (Paul, browser). B3–B5 verified by the automated staging check
instead (`smoke` section S4 on the real clock, run 44805295948: 8/8, 51/51 overall) — see below.

Website: https://courtbook-git-m3-dev-paul-bc50.vercel.app — sign in with your email code (your account
is admin on staging, so it also opens the staff calendar). Demo club Batroun. Report failures only, with
the step number. About 15 minutes.

## A. Game actions on the website (as yourself)

| # | Step | Expected |
| --- | --- | --- |
| A1 | Play → post a match at Batroun, padel, tomorrow, Ask to join, 3 players | It appears once on the board (the website posts without the app's retry key — checks 0073 compatibility) |
| A2 | Open it → Manage → edit players needed and switch to Join straight away → save | Saved; the page shows the new values |
| A3 | Manage → Make private, then Open to players | The status changes each time |
| A4 | Chat on it → send a first message | "Community rules" with the new wording appears once → I agree → the message is sent |
| A5 | Manage → Cancel match | Cancelled; the chat becomes read-only (this also tidies up) |

## B. Release-fix checks (Staff → Batroun calendar) — B3–B5 automated, see the end

| # | Step | Expected |
| --- | --- | --- |
| B1 | Add a block on a court later today | It shows and can be edited |
| B2 | In another tab: Courts → Batroun, same day | The blocked time shows as taken. Then delete the block |
| B3 | Add a walk-in that started 1 h ago; then one that started 3 h ago | First accepted; second refused: "A walk-in can be entered up to 2 hours after it started." |
| B4 | Extend the walk-in from B3 (in progress) by 30 min; then try to move it to start earlier | Extension works; the move is refused: "A booking cannot be moved to a time that has passed." |
| B5 | Add a walk-in from 2 h ago lasting 1 h (it has ended); try to move it | Refused: "This booking has already ended and can't be moved." Then cancel the walk-ins |

## Already covered by automated checks — no manual step

- Every database rule behind A and B: fixes suite 95/95 and M3 suites on a replica; staging `smoke`
  43/43 and `api` 46/46 (20 Nov, runs 44799779447 and 44799807745).
- Joining, asking, accepting, declining, removing, court-cancelled choices: database suites and the
  emulator run on staging; chat without duplicates: emulator and both phones.
- Reporting, blocking, moderation, Help & Feedback: phone checks (PASS) and the moderator check.
- Simulated payment refused for a real club: fixes suite (staging has no real club to try it on).
- Website sentences for every new refusal: website tests (all M3 codes).

## B3–B5 automated on staging (`smoke` S4, today's clock, three courts, cleaned up)

| Check | Result |
| --- | --- |
| Walk-in started 60–89 min ago | accepted |
| Walk-in started 3 h ago | refused `walk_in_too_old` |
| Extend the walk-in in progress by 30 min | accepted |
| Move the walk-in in progress to start earlier | refused `move_into_past` |
| Move a not-started booking into the past | refused `move_into_past` |
| Walk-in that already ended (started < 2 h ago) | accepted |
| Move the ended booking | refused `booking_ended` |
| The refused moves changed nothing | yes |

Gap (small): these refusals were checked in the database and their website sentences by the website
tests, not by clicking through the staff calendar's dialogs. S4 runs only between 11:00 and 22:00 Beirut.
