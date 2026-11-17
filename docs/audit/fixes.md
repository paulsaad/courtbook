# CourtBook — release fixes R2, S1/S5, D1, D3 (migrations 0068–0071) and native A1/I1

Prepared 17 Nov 2026 on `release-audit`, following Paul's decisions on the release-readiness audit
(`docs/audit/release-readiness.md`). **Nothing applied, deployed, built or merged.** M2 (`cec5a95`) is
unchanged: this branch merges it (so the fixes are built and tested on the M2 schema = live) and adds
commits on top.

| Branch | Content |
| --- | --- |
| `release-audit` | migrations 0068–0071, live/staging scripts, regression tests, this document |
| `release-native-fixes` (from `cec5a95`) | `mobile/app.json` corrections + `mobile/scripts/check-native-config.sh` |

## 1. The migrations

Each is minimal, safe to re-run, and changes only the objects named. Function changes are rebuilt from
`pg_get_functiondef` of a 0001–0066 database; the changed lines carry a `-- 0070`/`-- 0071` marker. A
schema fingerprint of 857 objects differs from 0001–0066 in exactly these 9: `blocks` policy (replaced),
`matches` delete policy (dropped), table grants on `matches` and `notifications`, `clubs.payment_mode`
default, constraint `clubs_simulated_only_demo`, and the bodies of `set_club_payment_mode`, `staff_book`,
`move_booking`.

### 0068 — R2: club blocks readable by that club's staff and admins only

```sql
drop policy if exists "blocks: read" on blocks;                       -- was: using (true)
drop policy if exists "blocks: staff read" on blocks;
create policy "blocks: staff read" on blocks for select using (is_staff_of(club_id));   -- admins included
```

Players never read `blocks`: the grid views `occupancy` / `public_occupancy` and the functions
`club_day_slots`, `next_free_slot`, `club_courts_free_now`, `club_discovery` run with their owner's rights.
Staff keep reading and writing through `"blocks: staff write"` (FOR ALL). The mobile app never reads
`blocks`.

### 0069 — S1 and S5 (brought forward from M3)

```sql
drop policy if exists "matches: organizer delete" on matches;   -- S1: cancelling is the only way to end a game
revoke delete on matches from anon, authenticated;
revoke update on notifications from anon, authenticated;        -- S5: no rewriting or re-queueing notices
grant update (read_at) on notifications to authenticated;
```

No web or app code deletes games or updates notices directly; the web marks notices read through
`mark_notifications_read` (security definer). These are exactly the corrections in the M3 safety review.

### 0070 — D1: simulated payment only at demo clubs; new clubs at the desk

1. Any existing **real** club in simulated mode is switched to `at_desk` with exactly the steps of
   `set_club_payment_mode`: its live holds and their pending payments expire, then the mode changes.
   Confirmed bookings and their payments are not touched. It names each club it switches.
2. `clubs.payment_mode` default `'simulated'` → `'at_desk'` (the admin "New club" form inserts with
   defaults — without this the rule below would make creating a club fail).
3. `check (payment_mode <> 'simulated' or is_demo)`, validated for every row.
4. `set_club_payment_mode` refuses simulated for a real club with `simulated_demo_only` (one line).

Fees are untouched (`service_fee_usd` default and values, booking fees); the $1 question stays separate.
The seed now sets the demo club's `payment_mode = 'simulated'` explicitly (fresh builds and staging
rebuilds keep today's demo behaviour; existing databases are unaffected).

### 0071 — D3: staff and past times

- `staff_book`: refuses a start more than 2 hours ago (`walk_in_too_old`); start ≥ now − 2 h is allowed.
- `move_booking`: refuses a new start in the past (`move_into_past`), **except** a booking in progress
  (started, not ended) that keeps its own start and still ends in the future — so the desk can still
  change its court or extend it, which the staff calendar offers today.

The window is real time (UTC), so local midnight and the clock changes behave correctly (tested below).
Unchanged: duration, grid and opening-hours rules, lock order, the exclusion constraint (`slot_taken`),
and moving any booking to a future time.

Web copy (3 lines in `src/lib/types.ts`, and its byte copy `mobile/shared/types.ts`, which CI requires to match) for the new refusals; without it the desk would see the code.

## 2. Compatibility checks and scripts (`supabase/live/`)

| File | What it does |
| --- | --- |
| `fixes_preflight.sql` | Read only. Part 1: every object to be replaced is exactly the verified 0001–0066 version (function code compared ignoring Windows line endings, as for 0065/0066; `move_booking`'s hash is the one verified on live after 0066). Part 2: what the fixes rely on (grid views run with owner rights, block readers are security definer, staff write policy, `mark_notifications_read`, `is_demo`, INV11). Part 3: **every club, and which ones 0070 will switch to the desk**, with holds released and upcoming bookings kept. |
| `0068_apply.sql` … `0071_apply.sql` | One transaction each for the SQL Editor: stops with nothing changed unless the pre-state is exact; runs the migration file byte for byte; rolls back unless the result is exact. A second run stops. 0070's prints the clubs it switched (the SQL Editor may not show NOTICEs). Generated by `make_fixes_apply.sh`; a test fails if they drift from the migrations. |
| `fixes_postcheck.sql` | Read only. 11 rows, all must be true after the four. |
| `fixes_rollback.sql` | One section per migration, newest first. Restores the 0001–0066 schema exactly (tested by fingerprint). Not undone by design: clubs 0070 switched stay at the desk. |

Staging scripts (`staging_smoke.sh`, `staging_api.mjs`) use only the demo club and future days: compatible.

## 3. Migration numbering — M3 plan update

| Number | Content |
| --- | --- |
| 0065–0066 | M2 (on live) |
| 0067 | **M3 `match_detail` — unchanged, still reserved** |
| 0068–0071 | these release fixes |
| next free numbers, assigned at approval in application order | favourites; M3 hardening (was "0068"); M3 chat (was "0069"); M3 push (was "0070") |

Changes to the M3 plan (to be written into `docs/m3/` when m3-foundation is integrated; the frozen
branches are not edited):

- **M3 hardening no longer contains S1 or S5** — they are 0069 here. Its tests T-S1, T-S5a, T-S5b are
  already satisfied (this suite's S1a–c, S5a–f) and stay as regression checks; nothing is applied twice.
- `docs/m3/repro/m3_findings.sh`: on a replica with 0069, **F3 and F9 report NOT REPRODUCED**; the
  stage-2 acceptance "all reproduced before hardening" now means all except F3 and F9.
- Files to renumber at integration: `02-safety-review.md` §2.3 migration plan (the "0068 Game hardening" row:
  drop S1 and S5), `06-test-plan.md` §AP heading and T-S1/T-S5 rows, `07-roadmap.md` stages 2, 4, 6.
- Order does not matter: 0001–0066 + {0067, 0068–0071, favourites draft} in three orders give identical
  schemas (877 objects); the 0067 suite (T-MD1–MD6 and its 9 mutants) passes on top of 0068–0071.

## 4. Recommended application order (each step needs Paul's approval)

1. Galaxy A17 test → M2 closed and merged to `main` (unchanged plan).
2. Merge `release-audit` into `main` after review (brings 0068–0071, tests, web copy). Vercel deploys the
   copy strings; harmless before the database changes.
3. **Staging:** `fixes_preflight.sql` → workflow *Staging database* `apply` (applies 0068–0071) →
   `fixes_postcheck.sql` → workflow `smoke` and `api` → web checks on staging (below).
4. **Live, one at a time in this order:** 0068 (R2), 0069 (S1/S5), 0071 (D3), then 0070 (D1) only after
   Paul has read preflight part 3 on live (it names any real club 0070 will switch). For each:
   `fixes_preflight.sql` → `00xx_apply.sql` → `fixes_postcheck.sql`. Apply outside desk hours
   (`lock_timeout` 5 s).
5. Phone checks (web, demo club): staff calendar shows and edits blocks; a player's grid still shows a
   blocked time as taken; staff enter a walk-in from 1 h ago (accepted) and from 3 h ago (refused with
   the new text); moving a booking to an earlier time today is refused; extending a booking in progress
   works; admin: switching a real club to "In the app" is refused with the new text.
6. Native corrections ship in the next native build after M2 (§6), with a version bump.

## 5. Tests actually run (17 Nov, local disposable databases)

| Suite | Result |
| --- | --- |
| `supabase/tests/fixes/run_fixes.sh` (new) | **88 ok, 0 FAIL** — A 34 role/behaviour checks; A′ the same checks on 0001–0066 fail exactly the 16 guarded items; B availability identical before/after (518 lines) and a control that must differ does; C 0070 on existing data (11); D 32 faked-clock checks incl. control; E audit; F live scripts (7) |
| — D: faked clock (libfaketime on a throwaway cluster) | ordinary afternoon; 2-hour boundary to 30 s (12:29:30 accepted, 12:30:30 refused); after local midnight; **clocks back** (Sat 30 Oct 2027, the repeated 23:00 hour); **clocks forward** (Sun 26 Mar 2028: a walk-in "2 h 59 ago" on the wall clock is 1 h 59 real, accepted); two desks entering the same walk-in at once → one booking, the other `slot_taken`. Control without the 0071 lines: exactly the 10 guarded checks fail |
| — C: 0070 on data | real club left simulated → switched, its live hold and payment expired, its paid booking untouched; demo club and its hold untouched; constraint validated; 13 invariants hold; re-run changes nothing |
| `supabase/tests/run.sh` (M2 suite) with 0068–0071 | **381 checks, 0 failures** (includes re-applying every migration from 0041) |
| `supabase/tests/audit/run_audit.sh WORKTREE` | 62 ok, 1 known (T1), 0 FAIL — RACE1–4 (two-session races) pass; R2, S1, S5, D1, D3 now pass |
| same, default (= live today) | 55 ok, 8 known, 0 FAIL (unchanged) |
| M3 `m3_findings.sh` on the fixed replica | F3 and F9 NOT REPRODUCED; others as before |
| M3 `match_detail_0067.sh` on the fixed replica | PASS, 9 of 9 mutants detected |
| Order check (fingerprint) | 0067 before/after 0068–0071, favourites before/after 0067: identical (877 objects) |
| Web: `tsc`, `vitest` | clean; 41/41 |
| CI "Mobile checks" on both pushed branches | green |
| Native: `mobile/scripts/check-native-config.sh` | PASS on `release-native-fixes`; FAIL (10) on `cec5a95` as expected |
| Native: `tsc`, `jest` | clean; 153/153 |

## 6. Native corrections (`release-native-fixes`, `b29046c`)

`mobile/app.json` only:

- `android.blockedPermissions`: SYSTEM_ALERT_WINDOW, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE. The
  app declares INTERNET and VIBRATE (haptics are used); libraries add INTERNET and ACCESS_NETWORK_STATE
  (expo-image, Sentry, expo-updates) and the storage pair (expo-file-system), which the block removes at
  merge. Expected final set: **INTERNET, ACCESS_NETWORK_STATE, VIBRATE** — confirm on the built APK.
- `ios.privacyManifests`: UserDefaults CA92.1, FileTimestamp C617.1, SystemBootTime 35F9.1, DiskSpace
  E174.1; no tracking. **Verified against the code:** a scan of every iOS native source the app links
  found exactly these four categories (React Native core, expo, expo-file-system, expo-constants,
  expo-eas-client, expo-system-ui, expo-updates). All but one library declare their own; **expo-updates
  uses UserDefaults and ships no manifest** — the gap that would trigger ITMS-91053. Sentry's native SDK
  is fetched at `pod install` and ships its own. Collected-data types are left empty: they belong to the
  store privacy answers (M5, B2), together with crash reporting once it is enabled.
- `expo-secure-store` `faceIDPermission: false`: removes the Face ID text; the app never requests
  biometrics (`requireAuthentication` is not used).

Isolation re-checked by prebuilding both apps: live `app.courtbook.mobile` / "CourtBook" / `courtbook`,
staging `app.courtbook.mobile.staging` / "CourtBook Staging" / `courtbook-staging`, nothing shared; the
corrections apply to both. The native fingerprint changes on both platforms, so the update workflow's
gate refuses to ship this over the air — it needs the next build, which should bump `version`
(runtime policy `appVersion`, today 0.3.0).

## 7. Points for Paul

1. **D3 interpretation:** a booking being played may still change court or be extended (keeping its
   start); moving any booking — even one that already ended — to a *future* time is unchanged. Say if
   either should be refused.
2. **D1 on live:** preflight part 3 will show whether any real club is in simulated mode; 0070 would
   switch it to the desk and release its open holds. Nothing else about money changes.
3. The admin settings page still lists "In the app (simulated…)" for every club; for a real club it is
   now refused with the new message. Hiding the option is a web change, not done.
