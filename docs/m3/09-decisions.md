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

## 9.2 Product decisions — accepted by Paul, 16 Nov 2026 (final)

| # | Decision | Accepted with | Where it lands |
| --- | --- | --- | --- |
| **P1** | A game may go ahead without a CourtBook court reservation (after a cancelled booking, or posted that way) | Players must clearly understand that no court is booked through CourtBook | GR-10; card, detail, join confirmation and push say "No court booked through CourtBook"; `court_resolved` copy (`04-ux-spec.md` §4.9) |
| **P2** | Reports admin page on the web and the moderation workflow | **No commitment to a review frequency is assumed** until Paul explicitly accepts the moderator responsibility | `05-architecture.md` §5.6 ("Review frequency: not set"); acceptance required before store submission (`02-safety-review.md` §2.5) |
| **P3** | Deleted messages stay deleted; report snapshots keep evidence of content reported before deletion | With access and retention safeguards | Admin-only access; snapshot cleared 180 days after closing unless on legal hold; tests T-MOD1, T-MOD6, T-MOD7 |
| **P4** | Web adjustments with 0068 (court-cancelled wording; game page on `match_detail`) | Staging regression checks before any live release | `02-safety-review.md` §2.5; `07-roadmap.md` stage 2 |

## 9.3 Engineering safeguards added by Paul (16 Nov)

| # | Safeguard | Status |
| --- | --- | --- |
| S-A | Before 0067: check every `match_detail` field against discovery permissions for signed-in non-participants (notes, booking identifiers…) | Done on the draft: field table in `02-safety-review.md` S6; `organizer_id` and `booking_id` withheld from non-participants; `FIELDS PASS`, mutation-checked. Repeat on the final migration (T-MD6) |
| S-B | Before delivery code: tests for lease expiry and overlapping workers, incl. a worker still running after another reclaims; no uncontrolled duplicates | Design: lease longer than any worker's lifetime + claim-id fencing + attempt cap 3 (push and email). Tests T-DL10–DL16 specified, required to pass before `deliver` is written |

## 9.4 Standing approvals still required

0067 (and each later migration) to staging, then separately to live; any live database change;
enabling production push or the live delivery job; the moderator role before store submission.
