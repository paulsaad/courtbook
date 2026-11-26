# Sports catalogue (F14 table tennis, F15 admin-managed sports, F16 alphabetical) — DRAFT

**Status: draft, not numbered, not applied anywhere.** Apply locally with
`EXTRA_MIGRATIONS=docs/sports/sql/sports_catalogue.draft.sql`.

## Why the database had to change

A sport was a Postgres **enum** (0001, 0028, 0040). Adding one needed a migration, even though the `sports` table
already held names, order and an active flag that admins could write.

## What the draft does

| | |
| --- | --- |
| Type | `sport` becomes a **domain over text**: a stable lower-case code, `^[a-z][a-z0-9_]{1,30}$`. Existing codes, columns, API payloads and app builds are unchanged. |
| References | `courts.sport`, `matches.sport` and `player_levels.sport` **reference `sports.code`** (foreign key). The arrays `profiles.sports` and `coaches.sports` are checked by a trigger. |
| Who manages it | **Admins only** (the existing RLS). Players and club staff cannot add or edit global sports. |
| Codes | Permanent: a guard refuses changing one, even by an admin. Names, aliases and the active flag can be edited. |
| Deactivating | Hides the sport from new choices: new courts, new games, profile and coach choices, discovery filters. **History is never touched**: courts, bookings, games and levels that use it stay as they are, and a court of a deactivated sport keeps working (deactivate the court to stop bookings). A sport in use cannot be deleted. |
| Table tennis | Code `table_tennis`, name "Table tennis", aliases "ping pong", "ping-pong" and "pingpong". **No Arabic name:** CourtBook is English only (Paul, 26 Nov), so the draft stops requiring the old `sports.name_ar` column (existing values untouched) and search does not use it. Discovery's text search matches a club's sports by name or alias. |
| Ordering | `club_sports` returns a club's own sports alphabetically by display name. The website orders every sport list by `name_en`. The app loads the catalogue (active, alphabetical) with a built-in fallback, so a sport an admin adds appears **without an app update** (with the neutral mark until a build draws one). |
| Functions | The 16 functions whose signatures used the enum are captured, dropped and re-created from their exact text with **identical grants**. Verified against a build without the draft: every function body and ACL is identical except the two intended changes, `club_sports` and `club_discovery`. |

## Evidence (local, 26 Nov)

| Check | Result |
| --- | --- |
| `run.sh` with the draft, release-candidate tree | 381/381 |
| `run.sh` with the draft, M12 tree (0093–0097) | 381/381; `fee_online` passes |
| `supabase/tests/sports/sports_catalogue.sh` | 21/21. Admin adds a sport and staff use it; player and staff refused; code permanent; deactivation keeps courts, levels and renames but refuses new uses; unknown or malformed codes refused; in-use deletion refused; `club_sports` alphabetical; "ping pong" discovery |
| Website `tsc`, vitest | 705 |
| App `tsc`, jest | 730 (new `sportsCatalogue.test.ts`); `check-shared` passes |

## Open before scheduling (for Paul)

1. **Table tennis level guide.** The ten levels are drafted in the style of the existing guide and marked for your
   review (`src/lib/levels.ts`).
2. **Older installed apps** keep their built-in sport list until updated. They can still see and book a table tennis
   court (shown with the neutral mark, labelled "Table_tennis"). The new app shows the catalogue name. Acceptable for a
   pilot; or ship the app update first.
3. **Migration number and slot:** after 0093 (pilot) and independent of M12 (applies on either line). Staging first,
   with the usual preflight and postcheck.
4. **Admin screen:** today admins edit the catalogue through the database/admin tools (RLS already allows it). A small
   `/admin/sports` page is a follow-up if wanted; it is not in this draft.
