# 0.5.0 on staging: order, checks and stop rules (prepared 28 Nov; nothing run; each step needs Paul's go)

Staging today (after the completed 0.4.0 rollout, 27 Nov): database 0001–0093; `staging-web` = WP `9567ed9`; the 0.4.0
staging app (build 1, runtime 0.4.0, channel `staging`) on Paul's Galaxy A17. Payments (M12, 0094–0098) stay off and
are refused by the workflow (any 0094–0098 file on the branch, named, or recorded blocks `apply`).

Workflow branch for every step below: the 0.5.0 candidate (this branch), which carries the 0.4.0 staging tooling
(merged from `staging-pilot-0093` a809671) plus the 0099–0101 actions. **Exception:** while staging is still at 0093
(steps 1–2), run `smoke` and `api` from `staging-pilot-0093`: this branch's versions test the 0099 calls and fail at 0093.

| # | Step | Before (read only) | After (read only) | Stop if |
|---|---|---|---|---|
| 0 | `check` | pending = 0099, 0100, 0101 only; nothing 0094–0098 | — | anything else pending |
| 1 | **Website WP-0.5.0** (`staging-web` fast-forward to the WP-0.5.0 commit) | rebuild with `docs/ops/staging-web-wp.sh <candidate> <current staging-web>`; tree equals the reviewed tree; guard SAFE; `staging-web` unchanged since | Vercel Ready; `deletion-retry` schedule Active; `m86_worker_check` < 35 min; next Sentry check-in ok; `/api/health` ok; `smoke` + `api` **from staging-pilot-0093** pass | any worker check fails |
| 2 | `apply 0099` (staff moves compare what the desk saw) | `f1_0099_preflight` | the workflow's postcheck; `f1_0099_postcheck`; `smoke`, `api` from this branch | postcheck fails (0099 IS applied; undo needs separate go) |
| 3 | `apply 0100` (sports catalogue; table tennis **inactive**) | `sports_0100_preflight` | postcheck; `smoke`, `cancel`, `api` | as above |
| 4 | `apply 0101` (player photos) | `photos_0101_preflight` | postcheck; `photos_0101_postcheck`; `m86_worker_check` | as above |
| 5 | Photo moderators (with MFA) named | — | `is_photo_moderator` for each | — |
| 6 | App update (OTA to channel `staging`, runtime 0.4.0) — separate decision | build page fingerprint = `c2add1fc…` | phone checks | — |
| 7 | Table tennis activation — separate decision | — | — | — |

**Between steps 1 and 2:** staff moves use 0091's call (the website falls back on PGRST202). After step 2 an open
pre-0.5.0 page is told to reload (`move_needs_reload`); the new page uses the 8-argument call.

**Between steps 1 and 4:** the website shows no photos and no photo controls (each photo call is optional and its
failure is ignored); the upload route answers 500 if called. Nothing else changes for players.

**Undo** (`undo_0099_0101`, one number, newest first, confirm_ref): 0101 (refused while any photo is stored; the
workflow never confirms discarding), then 0100 (refused while a new sport is in use), then 0099. Each returns the schema
exactly to the previous step (rehearsed: `.github/tests/staging-050-steps.sh`). The 0.4.0 website and app work at every
stage, so undoing never needs a website or app rollback first; undoing 0099 needs a website that still falls back (WP-0.5.0
does).

**Clients checked at every stage** (static database-call check, website-stage-compat and its app variant):
- WP `9567ed9` (staging today) at 0099, 0100, 0101: 0 missing, 0 refused.
- WP-0.5.0 at 0101: 0 missing; at 0093/0099/0100 only the photo functions (optional, handled) and, at 0093, the
  8-argument move (fallback) are absent.
- 0.4.0 app `d20e799` at 0093, 0099, 0100, 0101: 0 missing, 0 refused. 0.5.0 app at 0093 and 0101: 0 missing.
