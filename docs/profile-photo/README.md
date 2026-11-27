# Optional player profile photo — DRAFT (not applied, not deployed)

Status: isolated draft for review. The SQL is unnumbered (`sql/player_photos.draft.sql`) and runs nowhere until Paul
approves it and it gets the next free migration number. The web code ships safely before the schema: every photo read
is optional, so without the schema the profile and game pages look and behave exactly as today.

## What a player gets
- Profile: the existing round initials circle shows their photo when they have one. "Add a photo" / "Change photo" /
  "Remove", and one line saying who can see it.
- Game page: a 28 px round avatar next to each player — their photo if the viewer may see it, otherwise initials.

## Who can see a photo (decided in the database, per request, as the viewer)
- The player themself.
- A player who shares a **non-cancelled** game with them, where **both** are the organizer or an **accepted** player
  (past games count). Pending requesters do not see, and are not seen.
- Never across a block (either direction). Never for a suspended or closing/closed account. Admins get no special view.
- "No photo" and "not allowed" are the same 404, so the endpoint does not reveal whether a stranger has a photo.

## Storage choice (proposal — the one design decision to confirm)
The photo is a ≤ 64 KB, 256 × 256 WebP kept **in the database row** (`player_photos.image bytea`), not in a Storage
bucket. Why:
- no bucket and no storage policies to write, review or activate;
- upload is one transaction: there is never a file without a row or a row without a file (club-media needs an orphan
  ledger for exactly this);
- account deletion removes the photo at the data step, inside the database (hidden from the moment the account closes).

Cost: ~10–40 KB per player who adds one (1,000 photos ≈ 20–40 MB). Fine for the pilot and well beyond. If it ever
matters, moving to a private bucket later is mechanical (the route is the only reader and writer).

## Privacy and safety
- The server is the only writer (`set_player_photo` refuses any signed-in caller; granted to the service role only).
  Every upload is decoded and re-encoded by sharp: renamed non-images are refused, EXIF (including GPS) is dropped,
  the orientation is applied, the size is bounded. The table also refuses anything that is not WebP or is over 64 KB.
- Served with `private, no-cache` + ETag: the browser revalidates every time, so a new block or a closed account takes
  effect immediately (an unchanged photo costs a 304). `nosniff`, `default-src 'none'`, same-origin only.
- Writes require a same-origin request (Origin and Sec-Fetch-Site), on top of the SameSite=Lax session cookie.
- Account closure: the photo is hidden from everyone, the player included, from the moment the account closes. It is
  deleted at the account's data step (record → `data_removed`), which runs with the server key like the rest of the
  data step; that also catches an upload that raced the closure. Legal hold (`held`): kept, hidden.
- The table has 0086's closed-account lock-out, as every table must (0086 test E1).
- No table rights for anyone but the owner, **`service_role` included** (Supabase grants it every table by default;
  the server only uses the functions). This avoids repeating H1 on a new table.

## Verification before integration (26 Nov, after Paul's review)
Checked against the built database, not the SQL text. Two problems were found and fixed:
1. **Closing an account with a photo would have failed.** The first draft deleted the photo when the account closed,
   inside the player's own transaction. 0086 refuses every write by a closed account on every table, and requires
   that lock on new tables (its test E1, which the first draft also failed). With the lock in place, closing raised
   `account_closed`. Now the photo is deleted at the data step (server key). 0086's suites pass with the draft:
   deletion86, pipeline_e2e, races86. The old trigger fails the new P12 tests.
2. **The server key had full table rights** (Supabase default). Revoked; pinned by P15/P15d (they fail without it).

Also verified:
- **Size limits:** the browser shrinks to ≤ 1024 px before sending (a phone photo is often over Vercel's 4.5 MB
  request limit, which would refuse the upload before the route runs); the route refuses over 4 MB (413) and anything
  over 40 million pixels without decoding it (tested with a valid image just over the limit; fails if the limit is
  removed); the stored WebP is ≤ 64 KB and 32–256 px, enforced by the table (65,536 bytes accepted, one more refused).
- **Rights, exactly:** anon nothing; players `player_photo`, `match_photo_versions`, `my_photo_version`,
  `remove_player_photo`; only the server `set_player_photo`; the visibility rule and trigger for nobody; every function
  SECURITY DEFINER with a fixed search path; RLS on, no policy.

**Phone check still needed:** an upload from a real iPhone and Android photo (the browser shrink cannot be tested in
the test runner).

## Tests
- `PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos.sh` — 77 database cases on a scratch DB
  (visibility, blocks, pending, cancelled games, suspension, photo moderation and evidence; the real close and data step; races; legal hold;
  lock-out; exact rights; byte and size limits). `CONTROL=1` weakens the visibility rule: the 10 privacy cases fail.
- With the draft: `run.sh` 381/381; `m86/deletion86.sh`, `m86/pipeline_e2e.sh`, `m86/races86.sh` pass.
- `npx vitest run src/app/api/player-photo` — 36 cases: EXIF/GPS removal (fails if metadata is kept), pixel limit
  (fails if removed), sizes, WebP header, routes (which client runs which call, cross-site refusal,
  401/404/413/415/500, ETag/304). Website suite 739 passed; tsc clean; `next build` OK.

## Moderation and the upload limit (27 Nov, review requirements 2 and 3)

- **Moderation (Paul's decision 4, 27 Nov; replaces the earlier admin removal):**
  - *Who:* a **photo moderator** — an admin listed in `photo_moderators`, whose own account is active. The list is kept
    in the Supabase dashboard only (no client or server-key access); each addition and removal is written to the
    moderation log by a trigger. Being an admin alone gives no access to any player photo.
  - *Hide:* `moderator_hide_player_photo(report, reason)` removes the photo from every viewer at once, without suspending
    the account, and keeps a copy with the report. Reason required; logged as `hide_photo` (who, report, whose, why).
    The player can upload a new one; a repeat is handled by suspension.
  - *Evidence:* `photo_evidence` keeps a copy of the photo **when a player is reported** (so a later change or removal by
    the player loses nothing) and **when it is hidden**. Nobody reads the table directly. A photo moderator lists the
    copies of a report (`moderator_photo_evidence_list`, no bytes) and opens one through
    `/api/admin/photo-evidence/[id]` (`moderator_photo_evidence`); **every opening is logged** (`view_photo_evidence`).
    The route is `private, no-store`, no ETag, `no-referrer`; any refusal is the same 404.
  - *Retention and legal hold:* a copy lives as long as its report's text: kept while the report is open or on legal
    hold, deleted when the 180-day rule clears the report's text (0082's `enforce_report_retention`, unchanged) or the
    report is deleted. A held report's copy stays even if its text is cleared another way. Account deletion keeps it,
    as 0086 keeps report snapshots. A hide on a report already past the rule is refused (`report_expired`).
  - *Rollback:* refuses outright while any copy belongs to an open report or one on legal hold (no override); other
    copies go only with the same explicit confirmation as photos.
  - *Review of 02e7d06 (27 Nov), fixed:* versions come from one sequence and are never reused (a removed or hidden
    photo can no longer come back from a viewer's cache, and every copy keeps its own version); retention is the time
    rule on the copy itself (180 days after the report closed, unless open again or held), so reports with no text and
    reopened reports are covered; a held report holding copies cannot be deleted; the rollback locks the tables before
    its check; the moderation tables have 0086's lock-out; emptying the moderator list (TRUNCATE) is logged; a
    moderator never acts on or reads a report about themselves; the evidence route refuses cross-site requests before
    the database is asked, so a foreign link creates no log entry.
  - *Open decision for Paul (review S6):* the server key cannot read evidence, but whoever holds it could create a
    sign-in for a moderator through the Auth admin API, and the reading would be logged under that moderator. Option:
    require a second factor (Supabase MFA, `aal2`) for photo moderators; otherwise document it as accepted.
  - The reports board shows "Hide photo" and "Photo evidence" only to photo moderators (`is_photo_moderator`); the
    database checks again on every call.
- **Upload limit:** `claim_photo_upload(actor)`, server only, before the image is decoded: 10 attempts an hour per
  account (counted one at a time under a per-account lock), closed and suspended accounts refused first; 429 with a
  fixed message.
- The two open decisions from the review of b89b9ff (legal hold; admin view of a reported photo) were decided by Paul on
  27 Nov (decision 4) and are implemented as above.

## Not in this draft
- The phone app. Display needs no new server work (the app can call `match_photo_versions` / `player_photo` directly
  and render the bytes); upload needs the route to accept the app's bearer token. Proposed as a follow-up.
- Photos anywhere else (player lists, chat). Only the game's player list and the profile.

## Rollback (26 Nov)

`sql/player_photos.down.draft.sql` removes the feature exactly. Test:
`PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos_rollback.sh`, **8/8 on 0001–0092 and on the pilot
line 0001–0093**.
- **Exact:** up then down equals a plain build, all 1,773 schema and data items identical. A rollback that leaves one
  function behind fails it.
- **Guarded:** while any photo is stored, the rollback **refuses and changes nothing**, unless the person running it
  confirms in the same transaction (`set local courtbook.discard_player_photos = 'yes'`). Removing the feature deletes
  the photos.

## Privacy and store forms

See `PRIVACY.md`: what the policy and the Play/Apple forms must say, from what the code does, with the open legal
questions marked. The feature must not reach players before they are updated.

## Integration evidence (26 Nov, local test merge, nothing pushed)

`int/pilot-26nov` (pilot line, 0001–0093) + #73 (website details step) + #66 + this PR:
- **Merges:** the only conflict is one line in `src/app/failedReads.test.ts`, where #73 and this PR both edit the
  profile page's entry. The resolution keeps both: the profile entry with its optional photo read, and the new
  `/details` entry. `ProfileForm.tsx` and `profile/page.tsx` merge automatically: #73 changes the phone field, this PR
  the header picture.
- **Results:**
  - website vitest 838 passed, both `tsc` clean, `check-shared`;
  - app jest 829/829;
  - `run.sh` 381/381 with both drafts;
  - photo suite 36/36, now on 0001–0093;
  - 0086 `deletion86`, `pipeline_e2e`, `races86` pass with the draft.

