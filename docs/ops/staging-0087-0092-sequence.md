# Staging: 0087–0092 with the matching website per group (for independent review)

**Status: documentation only.** Nothing here runs until:

- the deletion trial has been evaluated (final evaluation 27 Nov, about 17:55 UTC);
- Paul has approved the rollout;
- Paul has given a separate go for each lettered step.

After E comes 0093 alone (`docs/ops/pilot-0093-staging.md`, PR #56), with its own go. M12 (0094–0096) never goes to
staging through this sequence.

**Decision (Paul, 25 Nov): the original approach.** The matching staging website is deployed with each migration
group, not once at the end. These steps are the same as steps 4, 5, 6 and 6b of `docs/ops/release-candidate-staging.md`;
step 6c (the legal drafts) stays a separate, staging-only step after E.

## 0. Starting point and ground rules

**Staging database:** 0001–0086. The R1 retry worker is live, and the 72-hour deletion trial has run on it.

**Staging website:**

- project `courtbook-staging`, branch `staging-web`, at `59a2f11` (#18 + the `deletion-retry` schedule and Sentry
  monitor);
- deploying = updating branch `staging-web`; Vercel builds it automatically.

**None of 0087–0092 replaces a deletion function** (`delete_account_data`, closing, the worker or
`deletion_requested`). The new tables carry the closed-account lock-out trigger, and the preflight checks it.

**The three website builds do not change** the retry route, `vercel.json` or `src/lib/deletion/monitor.ts` compared
with `59a2f11` (checked: an empty diff for those paths). So the trial's schedule and heartbeat code are untouched.

**All database actions** go through GitHub → Actions → **Staging database** → *Run workflow*:

- "Use workflow from": **`staging-pilot-0093`**. It has the 0087–0092 apply gate and no M12.
- `confirm_ref` = the staging project ref **exactly as the `check` action prints it** (deliberately not written here).

**How the apply gate behaves** (rehearsed locally; see §3):

- 0087–0092 only after 0086, alone in their run, in order, with no gaps.
- A run that includes 0087 runs the read-only preflight first. If the preflight fails, nothing is applied.
- Each file is applied in its own transaction, together with its record in `staging_meta.applied`. A failing file is
  rolled back, and nothing after it is applied.
- The idempotent demo seed is re-applied after every apply run. It has done so on every apply since 0001.
- When 0086–0092 are all present, the 0086–0091 postcheck runs and fails the job if any row is not ok.
- A number that is already applied is refused: the run fails and nothing is applied.

**Stop rules for every step:**

1. A red workflow run means stop. Do not re-run, do not try the next step. Report the run's log.
2. **A failure after a commit** (a postcheck after an apply, or a browser check after a website deploy) means stop and
   report. The applied migrations stay; going back is a forward fix or a website redeploy, and each needs separate
   approval.
3. **The trial's machinery must stay healthy throughout.** Run `m86_worker_check` (read only) before A and after every
   website deploy:
   - the heartbeat must be under 35 minutes;
   - no record may be stuck.

   After every deploy, also check in Vercel that the `deletion-retry` schedule is still **Enabled** for `staging-web`.
   If it shows Disabled, or the heartbeat goes stale: stop and report. Re-enabling needs Paul's go.

   **The heartbeat is a consistency check, not proof of execution** (Paul, 26 Nov). It records only the latest run.
   The worker's actual execution is verified independently at each check: Vercel's execution history for the
   `deletion-retry` schedule (every slot since the previous check delivered, no gap over 30 minutes) and the Sentry
   monitor's check-ins (no missed or error check-in). The postcheck row "app deletion gate follows the retry worker
   heartbeat" (#65) only proves that the gate and the heartbeat agree.

## 1. Steps

| # | Action | Writes | Website deployed with it | Check before the next step | Stop if |
| --- | --- | --- | --- | --- | --- |
| A | `rc87_preflight` (read only); `coords_audit` (read only); `m86_worker_check` (read only) | no | none | Every part-1 row ok. Part 2 noted (below). Worker healthy. | Any part-1 row fails. Part 2 shows a published club with unpriced times (price it first; else E is refused). |
| B | `apply`, migrations `0087 0088 0089`, confirm_ref | **yes** | **WB** (#19 favourites, areas, website Near me; #24 onboarding and map-link fixes) | The run says "running the preflight", then 3 applied and no postcheck yet. After deploying WB: areas, favourites and Near me in a browser; `coords_audit` again; `m86_worker_check`. | A published club disappears for players. Another account's favourites or areas are readable. |
| C | `apply`, migrations `0090`, confirm_ref | **yes** | none (0090 has no website change) | 1 applied, no preflight, no postcheck. `api` action (confirm_ref) PASS. | Any booking check fails. |
| D | `apply`, migrations `0091`, confirm_ref | **yes** | **WD** (#22 late confirmation, #23 desk price follows the move, #25 lint) | 1 applied, no postcheck yet. After deploying WD, the desk in a browser: walk-in, extend (price shown and confirmed), move, cancel. `m86_worker_check`. | "Paid in the app" is shown for an unpaid booking. A move changes a price without showing it. |
| E | `apply`, migrations `0092`, confirm_ref | **yes** | **WE** (#27 one price set-up, #30 player fixes) | The run says "all seven applied; running the postcheck", then "every required check ok". After deploying WE, in a browser: one price with one peak; a booked court cannot be switched off; a published club cannot open unpriced hours. `m86_worker_check`. | The postcheck fails: **0092 is applied**; stop and report. A quote differs from the rules shown. A booked court can be switched off. Unpriced hours are accepted. |

**Order inside B, D and E:** apply the migration first, then deploy the website. The website already on staging keeps
working on the newer database:

- the old move call still works when the price does not change;
- the gap between the two actions is minutes.

**Do not run `rc87_preflight` after B as a check.** It fails by design on a half-applied release (rehearsed).

### Preflight A

**Part 1 (all must be ok):**

- 0085 and 0086 applied, and nothing of 0087–0092;
- the lock-out trigger on every public table except the deletion tables;
- deletion records only in statuses 0086 knows;
- no overlapping live bookings or blocks;
- every pending payment belongs to a pending booking.

**Part 2 (information, counts only):**

- open deletion requests;
- published clubs without an exact map point, and half-filled map points;
- expired holds not yet swept;
- upcoming desk walk-ins;
- published clubs with offered times that have no price;
- upcoming bookings on switched-off courts;
- deletion records by status.

## 2. The three staging websites (built and tested locally, not pushed)

Each is a fast-forward of `staging-web` (`59a2f11`): WB, then WD on WB, then WE on WD. Built with ordinary merges, in
this order:

| Build | Merges (branch @ commit) | Result commit | Local results |
| --- | --- | --- | --- |
| WB | `repeat-use` (#19) @ `f5c9150`; `repeat-use-location` (#20) @ `9da7172`; `onboarding-usability` (#24) @ `94ad630` | `6e499a5` | tsc 0 · vitest 645 passed (1 skipped) · `next build` 0 |
| WD | `booking-late-confirm` (#22) @ `756e816`; `staff-ops-audit` (#23) @ `8e7c85d`; `lint-clean` (#25) @ `acf016a` | `afce917` | tsc 0 · vitest 674 · `next build` 0 |
| WE | `club-pricing` (#27) @ `0e8e75f`; `player-experience` (#30) @ `1088ab6` | `b85b566` | tsc 0 · vitest 692 · `next build` 0 |

**Notes:**

- **One conflict,** in WB's merge of #19: `src/app/delete-account/page.tsx`. It was resolved to the release candidate's
  own version of that file (from `1622ce8`): #18's "within 30 days" sentence plus #19's "favourite clubs and saved
  playing areas".
- **#20 (app Near me) changes only files under `mobile/`.** The website is identical with or without it. It is merged
  so that `staging-web` converges on the release candidate. The app reaches phones only through step 8's native build,
  never through `staging-web`.
- **#23's branch head `8e7c85d`** has one test-only commit more than the release candidate's copy.
- **Database calls (review of 25 Nov): tables, columns, permissions and functions are checked per stage.**
  `.github/tests/website-stage-compat/run.sh` reads every Supabase call in a website's `src/` (tests excluded). That
  covers `.from()` chains with their select lists, embeds, filters, ordering, insert/update/upsert keys and deletes,
  and `.rpc()` calls with their argument names. Each call is checked against a scratch database migrated to the stage
  (0001 up to that stage, on the repository's Supabase shim). For anon, authenticated and service_role, it checks
  that:
  - the table, view or function exists;
  - every column exists;
  - the table- or column-level privilege is granted;
  - RLS has a permissive policy for that command;
  - an rpc signature takes exactly those argument names, with EXECUTE granted.

  Any verdict that differs from a reference stage is reported.

  | Website | At stage | Reference | Table calls | RPC calls | Missing | Regression | Refused for its role |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | current `59a2f11` (minutes while B applies) | 0087, 0088, 0089 | 0086 | 112 | 136 | 0 | 0 | 0 |
  | **WB `6e499a5`** | **0089** | 0092 | 114 | 142 | 0 | 0 | 0 |
  | WB (C, and minutes into D) | 0090, 0091 | 0089 | 114 | 142 | 0 | 0 | 0 |
  | **WD `afce917`** | **0091** | 0092 | 115 | 143 | 0 | 0 | 0 |
  | WD (minutes into E) | 0092 | 0091 | 115 | 143 | 0 | 0 | 0 |
  | **WE `b85b566`** | **0092** | 0092 | 116 | 144 | 0 | 0 | 0 |

  **How the checker was itself checked:**
  - Deliberately wrong calls in `controls.json` are all caught; `run.sh` refuses to report unless they are: a missing
    column, a missing embedded column, a column-level revoke (`towns.created_by`), a delete with no RLS policy
    (`profiles`), wrong rpc argument names, an unknown embed, and a table that does not exist yet.
  - Negative check: **WE at 0089** reports the three functions it needs from 0091/0092 (`move_booking_priced`,
    `quote_move`, `set_club_base_prices`) as missing, and exits 1.

  **Non-literal calls:**
  - 13 calls through local wrappers (`call("fn", {...})`, `run("fn", {...})`) are now extracted automatically.
  - 5 calls whose keys come from a variable or a spread are resolved by hand in `manual.json`: the club settings
    update, the coach insert and update, and the two discovery searches. Their source text is identical in all four
    websites (checked).

  **Not covered by this check (stated):**
  - **Row visibility:** policy expressions are not evaluated. But no RLS policy changes on any table these websites use
    in the windows where an older website meets a newer database (0086→0089, 0089→0091, 0091→0092; compared).
  - **Function bodies:** only names, argument names and EXECUTE are checked; the behaviour of functions is covered by
    the release candidate's suites.
  - **New write rules:** 0092 adds triggers on `bookings`, `clubs`, `courts` and `price_rules` that refuse certain
    writes by design (switching off a booked court, leaving offered hours unpriced). WD would meet them only in the
    minutes before WE is deployed.
  - **The scratch database is not staging.** It has the same migrations and the shim mirrors Supabase's default grants;
    staging-specific data and state are what preflight A checks.
  - The websites use no Realtime subscriptions and no direct REST calls (checked).
- **WE compared with the release candidate (`90d7fcb`), website files only.** Two differences, both expected:
  - the legal drafts #14/#29: privacy, terms and their links, which are step 6c and staging only;
  - the staging-only deletion schedule: the Sentry check-ins in the retry route, `vercel.json` schedules and staging
    labelling in `src/lib/monitoring.ts`.

**Deploying (each with Paul's go, after its migration):**

```sh
git push origin <commit>:refs/heads/staging-web   # WB 6e499a5, then WD afce917, then WE b85b566; fast-forward only
```

- Never with `--force`. If `staging-web` has moved since `59a2f11`, the push is refused: stop and rebuild.
- Then check the Vercel deployment for `courtbook-staging` / `staging-web`: **Ready**, at that commit.

The local merge commits can be rebuilt with the same merges if needed. A rebuild gives different commit ids but the same
trees: compare with `git rev-parse <commit>^{tree}` before pushing.

### 2b. The approved pilot website on staging: WP (26 Nov, after Paul's integration approvals)

Paul approved #73–#78 (with #81), #80, #82–#84 and #86 for the pilot integration on 26 Nov: `int/pilot-26nov` @
`5f7875f`. That is the website the pilot runs, so staging should carry it after WE.

**Do not deploy `int/pilot-26nov-staging` to `staging-web`.** It does not contain `staging-web`'s deletion schedule (the
cron in `vercel.json`, the Sentry check-ins in the retry route, `src/lib/deletion/monitor.ts`, the staging label in
`monitoring.ts`). Deploying it would stop the deletion-retry worker. The staging website is built on `staging-web`'s
own line instead:

| Build | Merges | Result (local, not pushed) | Local results |
| --- | --- | --- | --- |
| **WP** | WE `b85b566` + `int/pilot-26nov` @ `5f7875f` | **tree `e2c92b5b64283f3599a31b4fa2c299c95c025f61`** (commit ids differ per build) | tsc 0 · lint 0 errors · vitest **914 passed** (1 skipped) · `next build` 0 |

**Build and guard:** `docs/ops/staging-web-wp.sh <pilot ref>` makes WP locally (never pushes). It resolves the one
known test conflict and prints the tree. It refuses unless the schedule files are byte-identical to `staging-web`.
`docs/ops/staging-web-wp.sh --check <ref>` runs the guard alone: it **refuses `int/pilot-26nov-staging`** (checked).
Run the guard on the exact commit before any push to `staging-web`.

- **One conflict,** in the test file `src/app/api/account/deletionRoutes.test.ts`, resolved to `staging-web`'s side
  (its monitor-aware clock and the Sentry monitor tests). No source file conflicted.
- **Checked file by file:** WP differs from `int/pilot-26nov` only in `staging-web`'s own files (`vercel.json`, the
  retry route, `src/lib/deletion/monitor.ts` and its test, the staging label in `monitoring.ts` and its test). Those
  files are byte-identical to `staging-web`. The deletion code differs from `staging-web` only by one sentence of
  wording (`copy.ts`: "favourite clubs, saved playing areas").
- **Database calls** (`website-stage-compat/run.sh`; the two `post_match` calls, whose arguments come from a spread,
  are resolved by hand in `manual.json`):

  | Website | At stage | Reference | Table calls | RPC calls | Missing | Regression | Refused for its role |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | `int/pilot-26nov` `5f7875f` | 0086 (staging today) | 0093 | 118 | 146 | **9** | 9 | 0 |
  | `int/pilot-26nov` `133dd5e` | 0092, 0093, 0093 + #72 (table privileges draft) | 0093 | 118 | 146 | 0 | 0 | 0 |
  | **WP (tree `e2c92b5…`)** | 0092 and 0093 | 0093 | 118 | 146 | 0 | 0 | 0 |

  At 0086 the nine missing calls are the 0087–0092 functions (favourites, playing areas, `quote_move`,
  `move_booking_priced`, `set_club_base_prices`). **So WP may be deployed only after step E (0092).** It works the
  same before and after 0093, and after a rollback of 0093. #72's privileges change nothing it uses.

**Where it fits (each with Paul's go):** step E applies 0092 and deploys WE as written; WP then replaces WE (a
fast-forward of `staging-web`, because WP is built on WE). 0093 (#56) may come before or after WP. Rebuild with the
same merge if needed, and compare `git rev-parse HEAD^{tree}` with the tree above before pushing.

## 3. Evidence (local)

- `.github/tests/staging-rc87-split-steps.sh`: this exact split, run with the workflow's own step scripts on a scratch
  0001–0086 database. **8/8:**
  - the preflight passes;
  - B applies three with the preflight first and no postcheck;
  - C applies one, with no second preflight;
  - skipping D (0092 before 0091) is refused, with nothing applied;
  - D applies one;
  - E applies, then the postcheck runs and passes;
  - re-running E applies nothing;
  - `rc_postcheck` (read only) passes.
- `.github/tests/staging-rc87-steps.sh` (12/12): mixed runs, gaps and resuming; 0094 is refused until 0093.
- `.github/tests/website-stage-compat/run.sh`: every website at every stage it meets, 0 findings (table in §2);
  controls caught; WE at 0089 correctly refused.
- The release candidate's full local matrix and the pilot build matrix include 0087–0092.

- `.github/tests/staging-0087-0093-full.sh` (26 Nov): the **whole sequence on one continuous database with
  staging-like state**. That state includes an account mid-deletion, the retry worker running, a pay-at-the-desk club
  and bookings. Steps: A → B (with a **forced failure in 0088**: the run stops with 0087 applied and nothing of 0088,
  then resumes with `0088 0089`) → C → D → E → 0093. After every step it checks five things:
  - the read-only actions, run twice, change nothing (a hash of every table);
  - pay at the desk books, repeats by token, and cancels;
  - the retry worker finds and claims the open deletion;
  - no overlapping bookings;
  - the checks leave no trace.

  After 0093, the account being deleted is refused at the desk. **45/45.**
- **It found two false stops in the staging check files, fixed in draft #65:**
  - the step-A preflight refused any deletion open in a 0086 status;
  - the step-E postcheck required the app's deletion gate to be shut, but the worker is running.

  On staging as it is, either would have halted the rollout. With 0092 already applied in the second case. **#65
  was approved by Paul (26 Nov) and is in `staging-pilot-0093` (`30ff70c`).** Re-run on that head: rc87 steps
  10/10, pilot 0093 steps 16/16, full sequence 45/45.

## 4. Rollback limits

- **No down migrations for 0087–0092.** They are additive or redefine functions, so going back means a forward fix.
  That is why each group is applied, checked and stopped separately.
- **Website:** fast-forward is the only deploy path. Going back means pushing a revert commit to `staging-web`, or
  promoting the previous deployment in Vercel, each with Paul's go.
- **Data written after a step stays:** favourites, areas, repriced walk-ins.
