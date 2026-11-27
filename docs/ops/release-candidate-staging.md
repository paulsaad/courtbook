# Release candidate (0086–0092, legal drafts): staging rollout plan

Status: **plan only.** Every step needs Paul's go. Staging first; live repeats the same steps later.

**Today:** staging is at 0085, live at 0077. The release candidate (PR #26) combines #18, #19, #20, #22–#25, #27 and
#28 on #13, plus the legal and store drafts #14 + #29, and passes every local suite. Local results are not evidence
about staging: each step below has its own check.

**Legal pages (#14, #29) — publication needs legal approval.** They may go to **staging** with the website (draft
banner, not indexed). They must **not reach the live website** while `LEGAL_STATUS` is `"draft"`: the live merge of
#14/#29 waits for the lawyer's approval and the switch to `"final"` (store package §1a). The app's links (#15) stay
out until the pages are final and public; `check-legal-pages --gate` enforces that for app builds.

**Step 0 needs nothing but Paul's go.** It is read only (SELECT under `default_transaction_read_only`): no retry
worker, no secrets beyond the existing `STAGING_DB_URL`, no automation bypass and no website deployment. Every later
step changes staging and needs its own go. **Each website version is deployed together with the migration it needs,
never earlier:** a website step ships only the PRs whose database changes are applied at that point (the column
"website"). The retry worker's configuration is needed only at step 3.

## Order and stop conditions

| # | Database | Website deployed with it (staging) | Needs before it starts | Must be true before the next step | Stop if |
| --- | --- | --- | --- | --- | --- |
| 0 | none: `staging-db` → `rc_preflight` (read only) and `coords_audit` (read only) | none | Paul's go | Highest applied is 0085; every part-1 row ok. Part 2 noted: open old deletion requests, published clubs without a map point or with unpriced times, upcoming bookings on switched-off courts. Coordinates audit reviewed | Any part-1 row fails: something is half-applied or the data is not clean |
| 1 | `apply 0086` | #13 + #18 (one-step deletion; the old app's calls keep working) | Paul's go; step 0 clean | `rc_postcheck` rows for 0086 ok; `m86_old_app` (rolled back) identical; `auth_checks` 33/33 | Any difference in the old app's answers: **the installed staging app would break**. Stop before any app update |
| 2 | none | none | step 1 | Paul, on the **currently installed** staging app: Delete account → request shown → Keep my account → withdrawn, account active | The old screen errors |
| 3 | none (R1 retry worker) | none | **Now, not before:** the Vercel automation-bypass secret, `CRON_SECRET_STAGING` and `DELETION_RETRY_URL_STAGING` in GitHub, `CRON_SECRET` on Vercel Preview (staging-only credentials, decided 24 Nov); then the schedule switched on, with Paul's go | `m86_worker_check`: heartbeat under 1 h after at least 4 scheduled runs; `/admin/deletions` says "last run …" | Heartbeat stale or a run fails: app deletion stays gated (safe); fix before step 7 |
| 4 | `apply 0087 0088 0089` | + #19 + #24 | step 1 (R1 not required) | Areas, favourites and website Near me in a browser; the coordinates audit again (read only) | A published club loses visibility; favourites or areas readable by another account |
| 5 | `apply 0090` | none (no website change) | step 4 | Postcheck row "0090" ok; `api` action PASS | Any booking check fails |
| 6 | `apply 0091` | + #22 + #23 + #25 | step 5 | `rc_postcheck` all ok; desk check in a browser: walk-in, extend (price shown and confirmed), move, cancel | "Paid in the app" shown for an unpaid booking, or a move changes a price without showing it |
| 6b | `apply 0092` | + #27 + #30 | step 6; step 0 showed no published club with unpriced times (else price them first) | Postcheck row "0092" ok; in a browser: one price with one peak; a booked court cannot be switched off; extending a published club's hours past its prices is refused | A quote differs from the rules shown, a booked court can be switched off, or a published club gains unpriced hours |
| 6c | none | + #14 + #29 (legal drafts, **staging only**, draft banner, not indexed) | step 6b | Pages show the draft banner; links from sign-in, profile and the 18+ question work | Any page reads as final |
| 7 | none (app, JavaScript only) | none | **step 3 verified** (R1 heartbeat) | Staging OTA of #18 + #19 + #30 code **without #20** (the fingerprint gate refuses native code): one-step deletion, areas, favourites, "Not now"; the A17 retest | The gate refuses, or a phone check fails: `rollback-to-previous` |
| 8 | none (app, native) | none | step 7 | Native build with #20 (version bumped), staging channel: Near me approximate only, prompt only on tap; `check-native-config` | Precise or background location requested |

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
| `CRON_SECRET` (Preview), `CRON_SECRET_STAGING`, `DELETION_RETRY_URL_STAGING`, Vercel automation-bypass secret (staging only) | Vercel + GitHub (Paul) | Step 3 only (not step 0) |
| No new variables for 0087–0092 or the website | — | — |
| App: none for the OTA; `expo-location` plugin already in `app.json` (#20) | — | Step 8 |

## Monitoring during the rollout

- Sentry (website) for route errors.
- `/admin/deletions` (heartbeat, stuck records).
- `staging-db` read-only actions after each step.
- **Backups:** staging has no restore promise. Live needs the B9 backup rule (a verified backup before applying)
  when its turn comes.
