# M3 — 9. Decisions

## 9.1 Settled engineering defaults (no approval needed)

| # | Decision | Status after review |
| --- | --- | --- |
| D1 | Fix the reproduced defects before native write screens | Kept. Now four migrations (0067–0070), each approved separately (`02-safety-review.md` §2.3) |
| D2 | Delivery driven by the database | Kept, **one change I am making on my own judgement:** a scheduled job drains the `notifications` queue every 15 s instead of a webhook per row. Reason: webhooks run on `pg_net`, which does not retry failed calls; the scheduled job is one mechanism that also does retries and recovery (`05-architecture.md` §5.5). At-least-once, duplicates possible only in a narrow crash window — stated, not hidden |
| D3 | Organiser can remove an accepted player before start; removal is final for that game | Kept (GR-6) |
| D4 | Report, block, filter, community rules in M3 | Kept (review point 5) |
| D5 | Waiting list = pending requests on a full approval game; one notice per fill; no automatic promotion | Kept (GR-4) |
| D6 | Court booking cancelled | **Replaced by Paul's rule** (GR-9): game, players and chat kept; joins and approvals paused; everyone told; organiser links another of their bookings, goes ahead without a CourtBook court (P1) or cancels; nothing booked automatically |
| D7 | Chat polling every 4 s, no Realtime | Kept; cursor verified, corrected client rule (`05-architecture.md` §5.4) |
| D8 | Push permission asked after first post or join | Kept |
| D9 | App wording "game", "organiser" | Kept |
| D10 | No fifth tab; Find a game from Home, Club → Games, Bookings → Games | Kept |
| D11 | Stitch review for board and detail before stage 1 screens; chat before stage 4 | Kept (`07-roadmap.md` §7.1) |
| D12 | Out of M3: hand-over, invites, Realtime, chat images, read receipts, automatic re-booking | Kept |

## 9.2 Product decisions that need Paul

| # | Question | Recommended | Why | If no |
| --- | --- | --- | --- | --- |
| **P1** | When the court booking is cancelled, may the organiser choose "go ahead without a CourtBook court" (players then see "No court booked" and are told)? | **Yes** | The organiser may have arranged a court by phone or at a club not on CourtBook; without this the only options are re-booking in CourtBook or cancelling. Joiners are always warned (GR-10) | Resolution = link another CourtBook booking or cancel |
| **P2** | Who moderates, and with what tool? | **Paul is the moderator during the pilot; a small admin "Reports" page is added to the existing web admin area in stage 4** (a production web change) | Paul is not a developer, so moderation needs a page, not SQL; reports also arrive by email | Reports by email only; actions done by me on request (slower) |
| **P3** | When a player deletes their own message, is the text kept for moderation? | **No** — deletion stays real (current behaviour); a report stores a snapshot of what was reported | Simplest and matches what players expect; evidence exists for anything reported before deletion | Keep deleted text hidden for 30 days (privacy policy must say so) |
| **P4** | Approve the web changes that go with 0068: two strings for "court booking cancelled", and the web game page reading `match_detail` (fixes its 404 after start) | **Yes** | Without them the web shows such games as "Private" | Web keeps current behaviour; native correct, web misleading |

Nothing else needs your approval before implementation, beyond the per-migration and live-release
approvals that are already standing rules.
