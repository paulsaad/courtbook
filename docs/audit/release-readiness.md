# CourtBook — release safety and readiness audit

Branch `release-audit` (from `main` 0ecf7a4). Audited schema: `mobile-m2-native` `cec5a95`, migrations 0001–0066 (= live). Audit date 17 Nov 2026.
Nothing was migrated, deployed, merged or changed in app behaviour. All mutation and race tests ran on local disposable databases.

## Verdict

- **Booking integrity and payment safety: no blocker.** The exclusion constraint held under real two-session races across every write path (hold, staff booking, move, cancel), the per-player desk cap is serialised, and all 13 booking/payment invariants hold for every app path.
- **Security: no blocker.** Players cannot escalate, confirm their own bookings or payments, or touch other players' data. Staff of one club cannot read or change another club's bookings or courts. The anonymous surface is six read-only functions. One should-fix privacy leak (R2).
- **Store release: blockers exist, all known and scheduled** — account deletion (M4), privacy policy and store privacy forms (M5). Two native should-fixes (A1 Android permissions, I1 iOS privacy manifest) need one native build and your approval.
- **Pilot:** safe once decision D1 is settled (every real club must be pay-at-the-desk, or real payments must exist).

## Findings by severity

### Blockers — store submission (already scheduled, not pilot blockers)

| ID | Object | Evidence | Impact | Fix | Verifying test | When |
|---|---|---|---|---|---|---|
| B1 | In-app account deletion | No delete-account path in app or DB | Apple guideline 5.1.1(v) rejects apps with sign-up but no in-app deletion; Google Play requires a deletion route too | Delete-account screen + server function (anonymise bookings, delete profile and auth user) | SQL test: deleted user leaves no profile/PII, bookings anonymised, slots stay consistent | M4 |
| B2 | Privacy policy URL, App Privacy answers, Play Data safety form | Drafts exist (`privacy and terms (drafts)` doc), not published | Both stores refuse submission without them | Publish policy at a stable URL; fill both forms | Checklist review before submission | M5 |

### Should-fix

| ID | Object | Evidence | Impact | Fix | Verifying test |
|---|---|---|---|---|---|
| R2 | RLS policy `blocks: read` on `public.blocks` | PRIV8/PRIV8b: a signed-in player reads `reason` ("Private lesson — Ahmad H. 03 123 456") and `created_by` (staff user id) of any club's blocks | Staff notes (names, phone numbers) leak to every signed-in user via the REST API. Players never need this table — they use `public_occupancy` | One migration: replace the policy with `using (is_staff_of(club_id) or is_admin())` | PRIV8/PRIV8b flip to ok (the audit then reports XPASS until updated); M2 suite + staff calendar unchanged |
| A1 | Android merged manifest | Prebuild of `cec5a95`: `SYSTEM_ALERT_WINDOW`, `READ/WRITE_EXTERNAL_STORAGE` (maxSdk 32) added by dependencies; app uses none | Play pre-review flags `SYSTEM_ALERT_WINDOW`; storage permissions inflate the Data safety form and the install permission list | `android.blockedPermissions` in `app.config.ts` for those three | Prebuild → grep merged manifest; Galaxy A17 smoke test. **Needs a native build — your approval** |
| I1 | iOS app-level privacy manifest | Prebuild: libraries ship `PrivacyInfo.xcprivacy`, the app target has none; `ios.privacyManifests` not set | App Store Connect warns/rejects with ITMS-91053 when required-reason APIs (UserDefaults, file timestamps, boot time, disk space) are used without a declared reason | Add `ios.privacyManifests` (NSPrivacyAccessedAPITypes with CA92.1, C617.1, 35F9.1, E174.1; tracking false) | First TestFlight upload with no ITMS-9105x email. **Native build — your approval** |
| P1 | `main` vs live schema | `main` has migrations to 0064; live has 0065–0066 (from M2) | A new migration written on `main` would reuse 0065/0066 numbers; deploys from `main` run against a newer schema | Resolved by the planned M2 merge — do not add migrations on `main` before it | `build_db.sh origin/main` count = 66 after merge |

### Decisions (behaviour is intentional or business-defined; not defects until you decide)

| ID | Object | Evidence | Impact | Options |
|---|---|---|---|---|
| D1 | `clubs.payment_mode` default `'simulated'`; no link to `clubs.is_demo` | BOOK3, BOOK4. With the simulated provider, `/api/pay/simulate` confirms immediately | A real club accidentally left in simulated mode gives players confirmed bookings with no money taken, unlimited | (a) default `'at_desk'`; (b) constraint `payment_mode <> 'simulated' or is_demo`; (c) both (recommended). Before the pilot: check each live club's mode on the admin page |
| D3 | `staff_book`, `move_booking` | BOOK2: a desk booking starting yesterday is accepted | Staff can create or move bookings into the past (useful for recording walk-ins after the fact; also a source of mistakes) | Allow (document) / refuse past starts / allow with a grace window (e.g. 2 h) |
| S5, S1 | `notifications` UPDATE policy; `matches` DELETE policy | CAT9, CAT10 — carried from the M3 review, present on live | Player can update more than `read_at`; organiser can hard-delete a match | Already planned in M3 migration 0068 — confirm timing only |

### Nits

| ID | Object | Evidence | Fix |
|---|---|---|---|
| T1 | `club_day_slots` on the night clocks go back (Beirut, 30→31 Oct) | BOOK5: club open 00:00–24:00 is offered 3 of 6 real half hours between 22:00 and midnight local | Generate slots in UTC steps over the local day. Only clubs open past 23:00 are affected, one night a year |
| N1 | Admin direct `update clubs set payment_mode` | Bypasses `set_club_payment_mode`, which expires live holds when switching to desk (INV11 shows the result on suite fixtures) | Admin UI already uses the function; add a trigger only if direct updates are ever needed |
| N2 | `NSFaceIDUsageDescription` | Added by the expo-secure-store plugin default; app never uses Face ID | Set the plugin option `faceIDPermission: false` with the next native build |
| N3 | `/api/pay/simulate` logs user id + payment id via `console.error` | Vercel logs keep internal ids (no names, emails or amounts) | Acceptable; drop `user` from the log when a real provider lands |
| N4 | `eas.json` `cli.version` is a loose range | Builds may use a newer EAS CLI than tested | Pin to the tested version |

### Notes (checked, acceptable)

- A late simulated confirmation of a hold that expired but was not yet swept succeeds. The slot was never released, so no double booking is possible (INV1, exclusion constraint). Acceptable.
- Universal links/App Links wait for the production domain (scheduled). Custom schemes `courtbook://` and the bundle id scheme are configured.

## Verified safe (with the test that proves it)

| Area | Result | Tests |
|---|---|---|
| Double booking under concurrency | staff_book vs held slot, move vs hold into one target: one winner, loser gets `slot_taken` | RACE1, RACE2 |
| Move + cancel of one booking | serialised, ends cancelled, no error | RACE3 |
| Per-player desk cap | two concurrent desk bookings at cap−1: one succeeds, other `too_many_upcoming` | RACE4 |
| Move onto an expired, unswept hold | succeeds; hold expired by trigger | BOOK1 |
| Booking/payment consistency | 13 invariants, 0 violations after races (one INV11 hit on the M2 suite DB = suite fixtures set mode directly, see N1) | INV1–INV13 |
| Role escalation, profile id change | refused | PRIV1, PRIV2 |
| Self-confirmation | direct insert/confirm of bookings or payments, `confirm_payment`, `staff_book` by a player: refused | PRIV3–PRIV7 |
| Player isolation | other player sees and cancels nothing of mine | PRIV9, PRIV10 |
| Cross-club staff isolation | read, book, move, cancel, court edits: refused | PRIV11–PRIV15 |
| Coach self-registration | invisible until a club approves | PRIV16 |
| Catalog hygiene | RLS on every table; every security-definer function pins `search_path`; none executable by PUBLIC; anon has no write grants; anon's functions = exactly 6 read-only; anon reads no sensitive table; write-policy set pinned; no client write policy on bookings/payments | CAT1–CAT8 |
| Secrets | full git history scanned: none; `.env*` ignored | manual |

Already verified in M2 and not repeated: crash-reporting separation (staging vs live), account switching clears cached data, offline and network-loss flows (Android E2E), accessibility automation, staging/production app identity, EAS fingerprint gate.

## Tests actually run (17 Nov)

| Suite | Result |
|---|---|
| `supabase/tests/audit/run_audit.sh` (new) | 55 ok, 8 known findings, 0 FAIL, 0 XPASS — PASS |
| same, `CONTROL=1` (exclusion constraint dropped in the scratch DB) | RACE1, RACE2, INV1 FAIL — proves the race tests detect a double booking |
| `supabase/tests/run.sh` on `main` | 348 checks, 0 failures |
| `supabase/tests/run.sh` on `cec5a95` | 381 checks, 0 failures |
| `invariants.sql` on the M2 suite DB | all 0 except INV11 = 2 (suite fixtures, N1) |

## How to run

```
PSQL="sudo -u postgres psql" bash supabase/tests/audit/run_audit.sh [git-ref]   # default origin/mobile-m2-native
CONTROL=1 PSQL="sudo -u postgres psql" bash supabase/tests/audit/run_audit.sh   # must FAIL RACE1/RACE2/INV1
```

Local Postgres only (`build_db.sh` refuses a non-local server). `invariants.sql` is read-only and can also be run on a staging snapshot.
When a finding is fixed its check reports XPASS and the run fails until the expectation is changed to `pass` — so fixes are never silent.

## Follow-up (17 Nov)

Decisions taken the same day: D1 approved, D3 approved with a 2-hour walk-in window and no moves into the past, R2 approved and prioritised, S5/S1 brought forward, A1/I1/N2 approved for the next native build. Migrations 0068–0071, live scripts and tests: `docs/audit/fixes.md`. Native corrections: branch `release-native-fixes`.
