# M2 (0086) rollout: one-confirmation account deletion — order and gates

Status: **plan only.** Nothing below is applied. Each numbered step needs Paul's approval. Written for the PR #18
review of 23 Nov (findings 1 and 3).

## Why the order matters

- The **released app** (the staging builds carrying the request-and-wait screen, OTA from `ed68d21` / `98ef905`) calls
  `request_account_deletion`, `cancel_account_deletion` and `my_account_deletion`. The live app (0.3.0) has no delete
  screen; the live database is at 0077.
- 0086 keeps those three calls working (finding 3):
  - an old app's request stays a **request**: cancellable for 24 hours, and the account is locked meanwhile;
  - after 24 hours the retry worker turns it into a closure (`promote_due_requests`);
  - a new one-step close turns it into a closure at once.
- The **new** app's one-step close works only while the retry worker has run in the last hour (finding 1).
  - Otherwise the database answers `processing_unavailable`.
  - The app then says deletion from the app is paused and points to the website. Nothing changes.
  - The website processes inline, so it never depends on the worker.
- Closing needs a sign-in in the last 10 minutes (finding 2).
  - Otherwise the database answers `reauth_required`.
  - The website and the new app then send an email code and retry.
  - Old apps never call close, so they are unaffected.

## Order (staging first, then live; each line is a separate approval)

| # | Step | Gate before the next step |
| --- | --- | --- |
| 1 | Apply 0086 to **staging** (`staging-db` → `apply`, migrations `0086`) together with the website at the PR's commit (staging preview) | `check` shows 0086 applied; the replica suites pass on the same commit |
| 2 | **Old-app compatibility on staging**: `staging-db` → `m86_old_app` (rolled back), then Paul on the phone with the currently installed staging app: Delete account → request shown → Keep my account → back to normal | Every answer equals the recorded one; the phone test matches |
| 3 | **R1 on staging**: set the staging target of `deletion-retry.yml` (variable, secret, Vercel bypass; see the activation doc), merge the workflow file to `main` so its schedule runs | `staging-db` → `m86_worker_check` shows a heartbeat under 1 h after at least 4 scheduled runs; the admin Deletions page says "Automatic processing: last run …"; an old-app request on a throwaway account (created only with Paul's approval at that time), backdated past 24 h, is promoted and finished by the schedule alone |
| 4 | Website closure on staging (throwaway account, Paul): stale session → email code → closed → signed out → finished inline | Admin page empty; the account cannot sign in |
| 5 | **App OTA** with the one-step screen to the staging channel; Paul on the phone | Email-code step shown when the session is old; closed; signed out; the schedule finishes it |
| 6 | Live: the same as steps 1–5 against live, R1's production target first, then the app update | Each gate as on staging |

**Never:** release the one-step app screen (step 5 or its live version) before step 3's gate passes on that environment.
If the worker stops later, the app refuses to start deletions there by itself, and the admin page shows the heartbeat in red.

## Rollback

| Step | Rollback |
| --- | --- |
| 1 | No down migration. 0086 is additive except the redefined functions. The previous app screen keeps working on 0086 (step 2 shows it). |
| 3 | Remove the staging variable or secret: runs then call nothing. One-step deletion from the app pauses within an hour. |
| 5 | Republish the previous OTA. |

## Evidence so far (PR #18, 23 Nov)

- **Replica:**
  - close tests 126/126; ported 0079 tests 102/102; 37 mutants detected; races 15/15 and 18/18;
  - pipeline end-to-end 93/93, including the takeover matrix (E9) and the old-app path (E10);
  - old-app answers recorded, and the released screen tested against them (app jest).
- **Staging Auth** (`staging-db` → `auth_checks`, no migration): 33/33.
