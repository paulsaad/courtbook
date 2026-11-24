# M12.1 (0093 fee_online payments) — staging procedure (DRAFT, not approved, nothing run)

Prepared 24 Nov 2026 on `m12-1-staging` (on top of the accepted M12.1 baseline `d22ec3c`, PR #34). **Nothing in this
document has been run on staging.** Each step below is run only with Paul's go, after the 72-hour deletion-scheduler
trial is complete and independently accepted.

## 1. Where staging is, and what 0093 needs

- **Staging database** (`pwznauyioqykdwodwpvx`): migrations 0001–0086 (staging step 1, 24 Nov). 0087–0092 are not
  applied.
- **0093 depends on 0087–0092.** Checked against the code:

  | 0093 relies on | From | How |
  | --- | --- | --- |
  | `move_price_plan`, `quote_move`, `move_booking_priced` | 0091 | 0093 replaces `move_price_plan` (0091's signature and its callers) |
  | `reject_booking_over_block` skipping the row being written | 0090 | a fee success just after the hold's deadline confirms the hold; without 0090 that confirmation fails |
  | `delete_account_data` | 0086 | 0093 replaces it (0086's body plus the shared fee rule) |
  | `bookings_need_active_court`, `set_club_base_prices` | 0092 | none directly; the replaced function bodies were taken from a 0001–0092 database, so applying 0087–0092 *after* 0093 would overwrite part of 0093 |
  | `club_readiness_rows` requiring `at_desk` for real clubs | 0081 / 0089 | keeps real-payment clubs unpublishable (§4) |

  0087–0089 add nothing 0093 uses, but `0093` is numbered after them: applying it first would make them "out of
  order". **Order: the release-candidate staging steps for 0087–0092 (`docs/ops/release-candidate-staging.md`, steps
  4–7, each with its own approval) first, then 0093.**
- **Rehearsed locally on a 0001–0092 database:** the preflight passes; 0093 applies; the postcheck passes; the
  fee-payment suite (60 checks) passes; the rollback returns a schema identical to 0001–0092 (fingerprint, 1334
  items), and 0093 applies again after it (`supabase/tests/payments/rollback_0093.sh`).

## 2. The staging website

The staging website (Vercel project `courtbook-staging`, Preview branch `staging-web`) must carry, together:

- the release candidate (0086–0092 website code),
- the deletion schedule (#32: `vercel.json` schedule, Sentry monitor),
- M12.1 (#34) and this branch.

A trial merge of #34 with #32 (24 Nov, local, discarded) has **one conflict**, in a test file only
(`src/app/api/account/deletionRoutes.test.ts`): take #32's side for both hunks. `vercel.json` comes from #32 unchanged,
so the deletion schedule keeps running. The combined commit is built and fully tested locally before it is pushed.

**Settings that stay as they are (real payments off):**

- Vercel `PAYMENT_PROVIDER`: not set → simulated.
- Vercel `PAYMENT_SITE_URL`: not set → every real provider is refused by the pay routes.
- Database setting `app.payment_provider`: not set → simulated.
- No new secrets, no paid services.

## 3. Steps (each needs Paul's go)

| # | Action (GitHub → Actions → Staging database, branch = the combined branch) | Changes staging? | Pass |
| --- | --- | --- | --- |
| 0 | `check` | no | pending lists `0093_fee_online_payments.sql` only |
| 1 | `m12_1_preflight` | no (read only) | every part-1 row `ok` (11) |
| 2 | `apply`, migrations `0093`, confirm_ref `pwznauyioqykdwodwpvx` | **yes** | the workflow reruns the preflight first and refuses 0093 with any other number; "1 migration applied" |
| 3 | `m12_1_postcheck` | no (read only) | every row `ok` (12) |
| 4 | `m12_1_functional` | no (one transaction, rolled back) | `60 checks, 0 failed`; afterwards 0 attempts, 0 charges |
| 5 | `smoke`, `cancel`, `api`, `rc_postcheck` | throwaway data, removed after | as before 0093 (desk and demo payment paths unchanged) |
| 6 | Push the combined commit to `staging-web` | website | Vercel deployment Ready; staging URL still asks for Vercel login; deletion schedule still listed and active; its next Sentry check-in `ok` |
| 7 | Paul on his phone, staging website (§5) | demo club mode, briefly | §5 |
| 8 | `demo_at_desk` | demo club back to the desk | the staging app books the demo club again |

**Stop rules.** Any failed check stops the procedure.

- Before step 2: nothing changed.
- After step 2: if step 3 or 4 fails, run `m12_1_rollback` (confirm_ref required).
  - It refuses, and changes nothing, if any fee-only payment, attempt, charge or `fee_online` club exists.
  - Otherwise it undoes 0093 and forgets it in `staging_meta.applied`, in one transaction.
- Website: redeploy the previous `staging-web` commit.

## 4. Real payments stay off for actual clubs

Enforced in the database, not only in the interface:

1. `set_club_payment_mode` refuses `fee_online` for a non-demo club while no real provider is configured.
2. `hold_slot` refuses a fee hold at a non-demo club with the simulated provider.
3. `club_readiness_rows`: a real club not at the desk cannot be published.
4. The pay routes refuse any real provider without `PAYMENT_SITE_URL`; the Whish adapter is not implemented.
5. The postcheck verifies 1–3 and that no real club is in `fee_online`.

The mobile app cannot pay a fee yet (M12.4). While the demo club is `fee_online`, the staging **app** cannot complete a
booking there; step 8 restores it.

## 5. Phone checks (staging website, demo club, simulated money)

Switch the demo club to "Court at the desk, booking fee online" in Admin → club settings. That is a staging data
change, reverted in step 8.

1. Reserve a court: the sheet shows "Court $X at the club + booking fee now", amount $1.00.
2. Pay the booking fee: the booking is confirmed; the booking page shows "Pay at the club $X" and "Booking fee, paid
   online", with the cancellation wording.
3. The desk calendar for that booking reads "court due at the desk · CourtBook booking fee paid online".
4. Cancel as the player: the fee is kept (the payment stays paid).
5. Book again; at the desk, cancel with "The club is cancelling" ticked: the payment shows refund due.
   - The admin refund queue lists real money only, so it stays empty here (simulated money is never refunded).
6. Set the fee to $0 and reserve: the booking is confirmed at once and no payment step is shown. Set the fee back
   to $1.
