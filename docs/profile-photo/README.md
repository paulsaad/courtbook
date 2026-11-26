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
- `PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos.sh` — 36 database cases on a scratch DB
  (visibility, blocks, pending, cancelled games, suspension, admin; the real close and data step; races; legal hold;
  lock-out; exact rights; byte and size limits). `CONTROL=1` weakens the visibility rule: the 10 privacy cases fail.
- With the draft: `run.sh` 381/381; `m86/deletion86.sh`, `m86/pipeline_e2e.sh`, `m86/races86.sh` pass.
- `npx vitest run src/app/api/player-photo` — 36 cases: EXIF/GPS removal (fails if metadata is kept), pixel limit
  (fails if removed), sizes, WebP header, routes (which client runs which call, cross-site refusal,
  401/404/413/415/500, ETag/304). Website suite 739 passed; tsc clean; `next build` OK.

## Not in this draft
- The phone app. Display needs no new server work (the app can call `match_photo_versions` / `player_photo` directly
  and render the bytes); upload needs the route to accept the app's bearer token. Proposed as a follow-up.
- Photos anywhere else (player lists, chat). Only the game's player list and the profile.
- Moderation/reporting of an offensive photo: the existing report flow covers the player; an admin "remove photo"
  action is a small follow-up if Paul wants it before launch.
