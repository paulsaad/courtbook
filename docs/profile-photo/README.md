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
- account closure deletes the photo in the same transaction as the status change.

Cost: ~10–40 KB per player who adds one (1,000 photos ≈ 20–40 MB). Fine for the pilot and well beyond. If it ever
matters, moving to a private bucket later is mechanical (the route is the only reader and writer).

## Privacy and safety
- The server is the only writer (`set_player_photo` refuses any signed-in caller; granted to the service role only).
  Every upload is decoded and re-encoded by sharp: renamed non-images are refused, EXIF (including GPS) is dropped,
  the orientation is applied, the size is bounded. The table also refuses anything that is not WebP or is over 64 KB.
- Served with `private, no-cache` + ETag: the browser revalidates every time, so a new block or a closed account takes
  effect immediately (an unchanged photo costs a 304). `nosniff`, `default-src 'none'`, same-origin only.
- Writes require a same-origin request (Origin and Sec-Fetch-Site), on top of the SameSite=Lax session cookie.
- Account closure: a trigger on `account_deletions` deletes the photo when the account enters closing / closed / held
  / data_removed / done. Not on the old cancellable `requested` state (hidden while open). The later `data_removed`
  transition deletes again, which catches an upload that raced the closure.

## Tests
- `PSQL="sudo -u postgres psql" bash supabase/tests/photo/player_photos.sh` — 26 database cases on a scratch DB
  (visibility, blocks, pending, cancelled games, suspension, admin, closure incl. the real `delete_account_data`,
  races, byte checks). `CONTROL=1` weakens the visibility rule and the privacy cases fail (10 of them).
- `npx vitest run src/app/api/player-photo` — 29 cases: EXIF/GPS removal (fails if metadata is kept), size, WebP
  header, routes (which client runs which call, cross-site refusal, 401/404/415/413/500, ETag/304).

## Not in this draft
- The phone app. Display needs no new server work (the app can call `match_photo_versions` / `player_photo` directly
  and render the bytes); upload needs the route to accept the app's bearer token. Proposed as a follow-up.
- Photos anywhere else (player lists, chat). Only the game's player list and the profile.
- Moderation/reporting of an offensive photo: the existing report flow covers the player; an admin "remove photo"
  action is a small follow-up if Paul wants it before launch.
