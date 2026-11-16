# M3 — 9. Decisions for Paul

Each has my recommended default. Where you don't answer, the default stands (per your instruction:
"document your recommended default and proceed").

| # | Decision | Recommended default | Why | Alternative |
| --- | --- | --- | --- | --- |
| D1 | Approve the hardening migration (S1, S2, S4, S5, S6, S8–S12, S14, S15) — staging first, live after your check | **Yes** | Fixes defects present on live today; the app's write screens should never run on them; web unaffected (checked) | Fix only S1, S2, S4, S5, S6 now (minimum for M3), rest later |
| D2 | How push and email are sent | **Database webhook → Supabase Edge Function** | Delivery no longer depends on the phone or browser calling a route; covers staff booking moves; no new paid tool | Bring G1 (`authenticateRequest`) from `payments-g1` for email only, and build push separately |
| D3 | Organiser can remove a player | **Yes, minimal** (before start, with notice; removal acts as a decline) | Otherwise the only remedy for a no-show or abusive player is cancelling the whole game | Not in M3 |
| D4 | Report, block, word filter, community rules | **Yes, in M3** (stage 4) | Required by Apple 1.2 and Google Play UGC for chat; cheap to build now | Defer to M5 (risks a store rejection late) |
| D5 | Requests on a full game | **Waiting list:** they stay pending, get one notice "You're on the waiting list", organiser can still accept if a place opens | Matches current data; no new concept | Auto-decline all pending when full |
| D6 | Game whose booking is cancelled | **Game stays open, labelled "No court booked yet"; organiser is told; the booking screen warns before cancelling a booking with players** | Current behaviour, made visible; organiser decides | Auto-cancel the game |
| D7 | Chat transport | **Polling every 4 s while open** | Boring, cheap, already the web's approach; Realtime can come later | Supabase Realtime now |
| D8 | When to ask for push permission | **After the first post or join/request**, with a pre-prompt | Asked when the value is obvious; one OS prompt only | At first launch |
| D9 | Wording in the app | **"game"** and **"organiser"** (web keeps "match") | Already used in Bookings → Games | "match" everywhere |
| D10 | Where Find a game lives | **Home entry + Club → Games + Bookings → Games; no fifth tab** | Keeps the approved four tabs | A "Play" tab |
| D11 | Design approval | **Stitch round for board, detail, chat before any screen code**; data layer may start once M3 is authorised | Follows the agreed workflow; avoids rework | Build from this spec and review on the phone |
| D12 | Out of M3 | Organiser hand-over, invites, Realtime, images in chat, read receipts | Not needed for the pilot; each adds risk | Pull any one in |

Also to note (no decision needed now): live push stays off until you approve, like live crash
reporting; the hardening migration is shown to you with its web-facing copy before staging.
