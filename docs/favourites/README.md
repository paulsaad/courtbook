# Favourite clubs and nearby discovery — foundation and assessment

17 Nov 2026. Branch `favourites-nearby`, from M2 `cec5a95` (M2 itself untouched). Independent of the
M3 branches, and merges with `m3-foundation` without conflict.

**Review (Paul with ChatGPT, 17 Nov):** design, optional nearby discovery, privacy approach, and the
Home / Courts direction approved; the read-only coordinates audit on staging and live approved (no
data changes). Two findings fixed in revision 2: the favourite cap under concurrent requests (§A),
and optimistic hearts versus overlapping refreshes and saves (§A, "App").

## Status

| Item | State |
| --- | --- |
| Favourites data layer, state helpers, unit tests | **Done, tested** — switched off (`FAVOURITES_AVAILABLE = false`) until the migration ships |
| Nearby: distance, sorting, location-permission flow, fallback, remembered choice, unit tests | **Done, tested** — no native module; device adapter not written |
| Club list sections (favourites / near me / discover) | **Done, tested** — pure logic |
| Favourites migration draft + SQL security tests | **Drafted, tested on the local copy only** (rolled back) — needs approval to apply |
| Coordinates audit (read-only query + its test) | **Done** on the local copy — needs approval to run, read-only, on staging/live |
| `expo-location`, permission strings, new build | **Not done** — needs approval (native change) |
| Screens: hearts, Home sections, Courts sections, area / location control | **Not done** — visual changes listed in §C need approval |

## A. Favourite clubs

**Model** (`docs/favourites/sql/club_favourites.draft.sql`; number assigned on approval — 0067 is
reserved for M3):

- `club_favourites (profile_id, club_id, created_at)`, **primary key (profile_id, club_id)** — a
  duplicate is impossible at the database level, not just in the app.
- RLS: a player reads only their own rows. Nobody else — other players, club staff, admin through
  the table — can see who favourited a club.
- No direct writes: the default Supabase grants are revoked; players get `select` only. The one
  write is `set_club_favourite(club, on/off)`: idempotent (the same request twice changes nothing and
  never errors), refuses inactive or unknown clubs, caps at 50 per player.
- The cap holds under concurrent requests: additions lock the player's profile row (the same
  per-player lock the booking functions take), so a second request waits for the first to commit
  and then counts it.
- `my_favourite_clubs()`: the caller's favourites among clubs active now, newest first. A favourite
  of a club that goes inactive is kept and comes back if the club returns; it can still be removed.
- Rows go with the account (`on delete cascade`) and with the club.
- Works alongside filters: the list the server returns for sport / area / search is only
  re-ordered; a favourite that doesn't match the filters isn't shown, and the app can say "1
  favourite doesn't match these filters".

**SQL tests** (`supabase/tests/favourites/club_favourites.sh`, local copy only, one rolled-back
transaction): **32 / 32 checks pass** — own-only reading, no direct insert / update / delete,
another player can't touch my rows, duplicate refused by the primary key, inactive and unknown clubs,
inactive → hidden → restored, removal while inactive, cap of 50, signed-out and anonymous refusal,
admin can't read players' favourites, account deletion, newest-first order, applying twice.
**9 deliberate mistakes, each caught** (e.g. letting players write the table, `using (true)`,
dropping the active check, granting the function to anonymous users). Database left as it was.

**Concurrency test** (`supabase/tests/favourites/club_favourites_concurrency.sh`, local only, in a
scratch copy of the replica that is dropped afterwards): two real sessions add the 50th and 51st
favourite at the same moment → 50 kept, the second refused with `too_many_favourites` after waiting
about 1.3 s for the first; two sessions adding the same club → one row, both succeed. **Control:**
the same race against the migration with the lock removed ends with 51 — the race is real and the
test sees it. Passed on three consecutive runs.

**App** (`mobile/lib/favourites.ts`): read hook (per-account cache key, no call when signed out) and
`createFavouriteSync`, one per signed-in account, which keeps the cached list — the one place hearts
and lists read from — consistent with the server:

1. A tap shows at once, after cancelling any fetch in flight, so its older answer can't land on top.
2. A refresh that starts during a save can still return the list from before it; every fetched list
   is re-applied with the pending choices before it is shown, so a heart never flips back mid-save.
3. One request per club at a time. Taps during a save only change the wish; the latest wish is sent
   when the save answers, if it differs (on → off sends two requests and ends off; on → off → on
   sends one).
4. Each answer touches only its own club: overlapping saves never roll each other back.
5. A refusal puts that club back to its last confirmed state, with the reason; no answer puts it back
   and re-reads. Never retried automatically.
6. When the last pending save settles, the list is re-read once, so the cache ends equal to the
   server.
7. Answers after an account change are dropped; nothing is written to anyone's list.

Regression tests cover each rule; removing rule 2, 3 or 6 from the code makes a test fail (checked).
`heartView` gives the heart's state and spoken label ("Add Batroun to favourites"); signed-out taps
lead to sign-in.

## B. Nearby discovery — assessment

**What the database has.**
- `clubs.lat`, `clubs.lng`: `numeric(9,6)` (≈0.1 m resolution), nullable, with a loose check
  (lat 33–35, lng 35–37). Staff can set them in club settings on the website. Both columns are
  public (readable by anyone, like the club's name), which is right: a venue's location is published.
- `towns.lat`, `towns.lng` exist but **none of the 347 towns has coordinates** (seeded without them).
- No distance function, no PostGIS. None is needed.

**How reliable the coordinates are.** On the local copy (migrations + seed): the demo Batroun club
has a plausible point (34.2553, 35.6586 — Batroun's coast); the other active test club has none.
**Live and staging data were not read** (no access without approval). The read-only audit
`supabase/tests/favourites/club_coordinates_audit.sql` lists, per active club: missing, half-filled,
outside Lebanon's extent, probably in the sea (a coast-line heuristic), the same point as another
club, a map link whose coordinates are more than 1 km away, a map link that could fill missing
coordinates, and no town. Its test passes on 17 known points (13 real places correctly unflagged).
**Known blind spot, recorded:** Lebanon's eastern border isn't a straight line, so a point in Syria
near Damascus passes; catching it needs town coordinates (club within ~15 km of its town).

**Recommendation — the simplest approach that leaks nothing:**
1. The phone reads the public club coordinates (`clubs: id, lat, lng` for active clubs) and computes
   straight-line distance itself. **The player's position is never sent** — not to Supabase, not to
   a map service, not in logs. No database change is needed for distance.
2. Position rounded to about 1 km as soon as it is read, kept in memory only; refreshed when the
   screen returns after 10 minutes; no background tracking. Only the *choice* "use my location" and
   the chosen area are remembered, never a position (tested: the stored value has exactly three
   fields).
3. Ask for **approximate** location only (Android `ACCESS_COARSE_LOCATION`; iOS "While Using"). It
   is enough to sort clubs and is the least a player has to grant.
4. Display "3.4 km", "Under 1 km", "27 km" — straight-line. In Lebanon's hills a drive can be
   1.5–2× that, so the screen should say distances are straight-line (or "as the crow flies") once.
5. Clubs without coordinates are never given a guessed distance: they come after the others, in the
   server's order. Distance is shown only where it is known.
6. No paid service: no geocoding or map API; `expo-location` is part of Expo (free).
7. Data: before the pilot's real clubs, run the audit read-only on live; set coordinates for every
   real club at onboarding (staff already can). Seeding town centres is optional and later.

**Location flow (done, `mobile/lib/nearby.ts`, behind a `LocationProvider` interface):**

| Moment | What happens |
| --- | --- |
| App start, choice never made | Nothing — no permission check, no prompt |
| App start, "use my location" chosen earlier | Permission is only *read*. Granted → one coarse fix. Withdrawn in Settings → location quietly off, manual area carries on. Never a prompt |
| Player taps "Use my location" | The only path that may show the system prompt |
| Refused | "Location is off. Choose an area instead, or tap Use my location to try again." |
| Blocked in Settings | No prompt (the system won't show one); "…turned off for CourtBook in your phone's Settings. Choose an area instead." |
| Location services off / GPS slow (8 s) / device error | Manual areas; a one-line note; nothing breaks |
| Player picks an area | The area wins: no "near me" section while an area is chosen |

## C. Home and Courts — recommendation

Keep the four tabs and the approved Home. Sections use one shared function
(`mobile/lib/clubSections.ts`), so the same club never appears twice on a screen:

| Mode | Sections |
| --- | --- |
| No area chosen, no search, location on | **My favourite clubs** (nearest first) → **Clubs near me** (up to 5, within 25 km) → **Discover more clubs** (nearest first; clubs without coordinates last) |
| No area chosen, no search, location off | My favourite clubs (newest first) → Discover more clubs (server order) |
| Area chosen | My favourite clubs in that area → the rest (server order). No "near me" |
| Search typed | One list in the server's order; favourites marked with a filled heart, not moved |

Sport and area filters always apply first; sections only re-order what they return.

**Where:**
- **Courts tab** (the club list): an area control above the sport chips — "All Lebanon ▾" with
  "Use my location" at the top of its sheet — then the sections above, hearts on the cards, distance
  on the card's second line. Its data stays `club_day_slots` for the chosen day (it already accepts
  governorate / district); sections work on any list with club ids.
- **Home:** under the "Book a court" card and above "Your next booking", a compact **Your clubs** row
  (favourites, up to 5, each with its next free time; tap → the club) — only when signed in with at
  least one favourite. "Near you" on Home only when location is on (up to 3, excluding favourites).
  A "See all clubs" link to Courts. No change to the rest of Home.

**Visual changes needing approval before screens** (no Stitch pilot proposed; a short review of
these items is enough):
1. Heart icon on club cards: position (top-right of the card), filled red when on — red is the brand
   accent and the Phase 7 palette already names "favourite heart" as one of its uses — and a 48 pt
   touch area.
2. Section headings on Courts and the compact "Your clubs" / "Near you" rows on Home.
3. The area control and its sheet ("All Lebanon ▾", governorate → district, "Use my location").
4. The pre-permission line before the system prompt, and the fallback notes above.
5. Distance text on cards and the one "straight-line distance" note.

## D. Safety and verification

| Risk | Handling | Tested by |
| --- | --- | --- |
| A player reads or changes another's favourites | RLS own-only read; no table writes; function acts on `auth.uid()` only | SQL F3, F5, F6, M2, M3, M9 |
| Duplicates | Primary key; idempotent function | SQL F2, F4, M4 |
| Cap exceeded by simultaneous requests | Per-player lock before counting | concurrency test + no-lock control |
| Hearts out of step with the server (overlapping taps, refreshes, failures) | Sync rules 1–7 above | unit: `favourites` regressions |
| Inactive / unknown clubs | Refused on add; hidden on list; kept for return; removable | SQL F7, F8, M1, M5 |
| Anonymous or signed-out calls | No grant to anon; `not_authenticated` | SQL F1, F10, M6, M8 |
| Location privacy | Never sent; coarse; memory only; only the choice stored | unit: `nearby` (coarsen, prefs), `clubDirectory` (request carries no position) |
| Missing / bad coordinates | Unusable points dropped; no guessed distance; listed last | unit: `nearby`, `clubSections`; audit + test |
| Permission refused / blocked / services off / slow fix / errors | Manual areas; one-line notes; never a crash; never a launch prompt | unit: `nearby` (permission and location cases) |
| Account changed mid-save | Late answer dropped, nothing written; cache keyed per account (and cleared by M2's session provider) | unit: `favourites` |
| Slow connection / offline | Heart reverts and re-reads; lists keep cached data; no automatic write retry | unit: `favourites` |
| Database errors | Shown with retry; "function missing" is treated as "not available yet", not an error | unit: `favourites`, `clubDirectory` |

## Test results (17 Nov)

| Check | Result |
| --- | --- |
| Mobile unit tests | **227 passed** (153 existing unchanged + 74 new) |
| Type check | clean |
| Shared copies | match the website (`geo.ts` added) |
| Favourites SQL tests (local copy, rolled back) | 32 / 32; 9 / 9 mutants caught; nothing left behind |
| Favourites concurrency (scratch copy, dropped) | cap holds with two real sessions; control without the lock breaks it (51) |
| Coordinates audit test (local copy, rolled back) | 17 / 17 |

## Approvals

Approved (17 Nov): the product decisions, the design direction for the five visual items in §C, and
the read-only coordinates audit on staging and live (no data changes).

Still needed, after M2 closes:
1. The favourites migration: number, then staging, then live (separately).
2. Adding `expo-location` (approximate location only), the permission texts, and the new build.
3. Switching `FAVOURITES_AVAILABLE` on, in the same change that ships the migration.
4. Screen implementation and deployment.
