# Optional player photo — privacy and store-form requirements (for the lawyer and the store forms; DRAFT)

The facts below are what the code in this PR does. The legal wording, and every point marked **Q**, are for the lawyer.
The photo feature must not reach players before the privacy policy (M1/PR-4) and the store forms describe it.

## Facts to state

| Topic | What CourtBook does |
| --- | --- |
| What is collected | Only if the player chooses to add one: one profile photo |
| Processing | Uploaded through our website. Our server decodes it and keeps only a new 256 × 256 WebP image (at most 64 KB). The original file is not stored. Location (GPS) and all other photo metadata are removed. |
| Where it is kept | In CourtBook's database, with the rest of the account data (same provider and region as the other account data in the privacy policy) |
| Who sees it | The player. The organiser and accepted players of a game the player shares with them, as long as that game is not cancelled (past games included). Never someone the player blocked or who blocked them. Not shown while the account is suspended or closing. Not public, and not visible to other players in lists or search. |
| Admins | No special view in the app. CourtBook staff with database access could technically read it, as with any account data **(Q: say so in the policy?)** |
| Not done | No sharing with third parties; no advertising, analytics, profiling, face recognition or model training |
| Removal by the player | "Remove" deletes it from the database immediately |
| Account deletion | Hidden from everyone the moment the account closes; deleted at the account's data step; kept hidden (not deleted) while a legal hold applies |
| Backups | A deleted photo remains in database backups until they expire under the hosting plan's backup retention **(Q: state the period — confirm it with M5's backup set-up)** |
| Upload limit | At most 10 upload attempts an hour per account, counted on the server before the image is read; the attempt log holds only the account id and time; entries older than a day are removed at the next upload, and all are deleted with the account |
| Offensive photos | Players can report a player. An admin can remove a photo without suspending the account (`admin_remove_player_photo`, reason required, recorded in the moderation log; review requirement 2, 27 Nov). The player can upload again |

## Store forms (to confirm against the final build)

- **Google Play Data safety:**
  - "Photos and videos → Photos": collected, optional, for app functionality;
  - processed for the account; deleted on request (in-app removal and account deletion).
  - **Q:** whether showing it to other game players counts as "sharing" under Play's definitions. Play exempts
    transfers the user initiates and expects; the lawyer should confirm.
- **Apple App Privacy:** "Photos or Videos", linked to the user, for app functionality, not used for tracking.
- **Permissions:** the website uses the browser's file picker; no new native permission (the app is not part of this
  PR). If the app later adds photo upload, its photo-library permission text must be added to the store package.

## Wording already in the product (for consistency)

- Profile, under the photo: "Optional. Only you and the players in your games can see it."
