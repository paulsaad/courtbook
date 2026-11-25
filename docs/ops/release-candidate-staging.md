# Release candidate (0086–0092): staging rollout plan

Status: **plan only.** Every step needs Paul's go. Staging first; live repeats the same steps later.

**Today:** staging is at 0085, live at 0077. The release candidate (PR #26) combines #18, #19, #20 and #22–#25 on
#13 and passes every local suite. Local results are not evidence about staging: each step below has its own check.

## Order and stop conditions

| # | Step (how) | Must be true before the next step | Stop if |
| --- | --- | --- | --- |
| 0 | `staging-db` → `check`, then `rc_preflight` (read only) | Highest applied is 0085; every part-1 row ok. Note the part-2 counts (open old requests, clubs without a map point, upcoming walk-ins) | Any part-1 row fails: something is half-applied or the data is not clean |
| 1 | `apply`, migrations `0086` only, together with the website preview built from #18 (merged into the staging branch) | `rc_postcheck` rows for 0086 ok; `m86_old_app` (rolled back) identical; `auth_checks` 33/33 | Any difference in the old app's answers: **the installed staging app would break**. Stop before any OTA |
| 2 | Paul on the phone with the **currently installed** staging app: Delete account → request shown → Keep my account | Request withdrawn; account active | The old screen errors |
| 3 | R1: configure the staging retry target (needs the Vercel bypass decision), then merge `deletion-retry.yml` to main | `m86_worker_check`: heartbeat under 1 h after at least 4 scheduled runs; `/admin/deletions` says "last run …" | Heartbeat stale or a run fails: app deletion stays gated (safe); fix before step 7 |
| 4 | `apply` `0087 0088 0089` with the website from #19 (+#24) | `repeat_use` behaviour on staging: the website check of areas, favourites and Near me in a browser (staging `web_accept`, after adding M14 steps); the coordinates audit (read only) | A published club loses visibility; favourites or areas readable by another account |
| 5 | `apply` `0090` | Postcheck row "0090" ok; `api` action (booking checks through Supabase's API) PASS | Any booking check fails |
| 6 | `apply` `0091` with the website from #23 | `rc_postcheck` all ok; `staff_ops`-equivalent desk check in a browser: walk-in, extend (price shown and confirmed), move, cancel | The calendar shows "paid in the app" for an unpaid booking, or a move changes a price without showing it |
| 6b | `apply` `0092` with the website from #27 | Postcheck row "0092" ok ("applied"); in a browser: set one price with one peak on a club with no prices; Prices lists the expected rules; deactivating a court with an upcoming booking is refused with the plain message | A quote differs from the rules shown, or a booked court can be deactivated |
| 7 | **App OTA to staging, JavaScript only:** #18 + #19 code **without #20**. The update workflow's fingerprint gate refuses native changes, so this needs a branch without `expo-location` | Paul's phone: one-step deletion (email code if the session is old), areas, favourites, "Not now"; the A17 retest | The gate refuses (native code slipped in), or any phone check fails: republish the previous update (`rollback-to-previous`) |
| 8 | Native build with #20 (app version bumped, e.g. 0.4.0), staging channel | Near me: approximate only; prompt only on tap; Beirut/Batroun behaviour; `check-native-config` | Precise or background location requested |

## Rollback limits (read before step 1)

- **No down migrations.** 0086–0092 are additive or redefine functions. Going back means a forward fix.
- **Website:** redeploy the previous staging preview. Old pages keep working on the new database:
  - the old move call still works when the price does not change;
  - the old deletion calls still work (step 1's checks).
- **App:** `rollback-to-previous` for an OTA. A native build cannot be rolled back on phones; only a newer build
  replaces it.
- **Data written after step 1** stays:
  - closed accounts;
  - favourites and areas;
  - repriced walk-ins.

  None of it is lost by a website or app rollback.

## Environment and configuration needed (nothing set yet)

| What | Where | Needed by |
| --- | --- | --- |
| `CRON_SECRET` (Preview), `CRON_SECRET_STAGING`, `DELETION_RETRY_URL_STAGING`, Vercel bypass secret | Vercel + GitHub (Paul) | Step 3 |
| No new variables for 0087–0092 or the website | — | — |
| App: none for the OTA; `expo-location` plugin already in `app.json` (#20) | — | Step 8 |

## Monitoring during the rollout

- Sentry (website) for route errors.
- `/admin/deletions` (heartbeat, stuck records).
- `staging-db` read-only actions after each step.
- **Backups:** staging has no restore promise. Live needs the B9 backup rule (a verified backup before applying)
  when its turn comes.
