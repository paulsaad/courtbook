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
- **Database calls:** every `rpc("…")` name in WB exists in migrations up to 0089, in WD up to 0091, and in WE up to
  0092. Only names were checked, not table reads.
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
- The release candidate's full local matrix and the pilot build matrix include 0087–0092.

## 4. Rollback limits

- **No down migrations for 0087–0092.** They are additive or redefine functions, so going back means a forward fix.
  That is why each group is applied, checked and stopped separately.
- **Website:** fast-forward is the only deploy path. Going back means pushing a revert commit to `staging-web`, or
  promoting the previous deployment in Vercel, each with Paul's go.
- **Data written after a step stays:** favourites, areas, repriced walk-ins.
