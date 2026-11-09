# CourtBook

Mobile-first PWA for booking sports courts, coaches and finding players. Piloting in North Lebanon.
Spec: *Court booking app — product spec v0.1* (project knowledge).

Stack: Next.js (TypeScript) · Supabase (Postgres, RLS, auth) · Vercel · GitHub.

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/0001_init.sql` | Full schema: tables, enums, double-booking guards, `book_slot` / `cancel_booking`, RLS |
| `supabase/migrations/0017_payments_summary.sql` | `payments_summary(month)`, `payments_list(club, month)`, `refunds_due()`; staff may `mark_refunded` |
| `supabase/migrations/0016_club_admin.sql` | Club setup RPCs: `update_club_settings` (staff), `add_club_staff` / `remove_club_staff` / `club_staff_list` (admin) |
| `supabase/migrations/0015_one_hold_per_player.sql` | `hold_slot` serialized per player (profile lock first); partial unique index: one pending hold per player |
| `supabase/migrations/0014_lock_order.sql` | One lock order everywhere (court → booking → payment); `already_paid` only for identical retries |
| `supabase/migrations/0013_hold_ux.sql` | Expired holds invisible + swept by any booking/block on the court; new hold replaces the player's previous one; `my_active_hold()` |
| `supabase/migrations/0012_payments.sql` | Payments model: `payments` table, `hold_slot` (pending hold, frozen price), `confirm_payment` (service role, idempotent), `release_hold`, `quote_price`, refund rules in `cancel_booking` |
| `supabase/migrations/0011_booking_status_values.sql` | Adds `pending` / `expired` booking states (separate file: enum values can't be used in the same transaction) |
| `supabase/migrations/0010_player_names_scope.sql` | `player_names` returns only self, bookers at the caller's club (staff), or match co-participants |
| `supabase/migrations/0009_player_names_fn.sql` | `player_names(ids)` lookup replaces the `player_public` view (no directory listing) |
| `supabase/migrations/0008_flexible_durations.sql` | 30-min grid; `min_booking_minutes` / `max_booking_minutes` per club for players; prices per hour |
| `supabase/migrations/0007_phase1_schema.sql` | `clubs.booking_window_days` (default 14), `close_club()` whole-club closure, `player_public` view (replaced in 0009) |
| `supabase/migrations/0006_duration_utc.sql` | Duration = real elapsed time (DST-safe) |
| `supabase/migrations/0005_validation_edges.sql` | Exact-minute grid, no midnight exception (`close_time = 24:00` for midnight), staff cannot mark own booking club-caused |
| `supabase/migrations/0004_slot_validation_trigger.sql` | Trigger: every court booking inside opening hours, on the grid, k × slot_minutes; players exactly 1 slot |
| `supabase/migrations/0003_cancel_reason.sql` | `cancel_booking(id, club_caused)`: refund after cutoff only when staff mark it club-caused |
| `supabase/migrations/0002_review_fixes.sql` | Phase 0 review fixes: per-player lock, (court, club) FKs, function privileges, `move_booking` / `mark_no_show`, slot validation |
| `supabase/seed.sql` | Demo club (Batroun), 5 courts, peak/off-peak prices, credit packs. Idempotent |
| `supabase/tests/run.sh` | Local Postgres test: concurrent double-booking, blocks, credits, RLS |
| `src/lib/supabase/` | Browser and server Supabase clients |
| `src/app/` | Pages: `/` clubs · `/club/[slug]` availability + hold · `/pay/[id]` · `/bookings` · `/profile` · `/staff/[slug]` calendar + `/settings` · `/admin` clubs, `/admin/clubs/[slug]`, `/admin/payments` · `/api/pay/simulate` |

## Payment model (Phase 2+)

Player pays court price + `clubs.service_fee_usd` in the app. Lock order in every RPC: player → courts (id order) → booking → payment. `hold_slot()` creates a `pending` booking (occupies the slot like a confirmed one) and a `payments` row with the price frozen; the hold expires after `clubs.hold_minutes`. Stale holds are expired inside the next `hold_slot()` on the same court (serialized by the court row lock). The browser never confirms a payment: `/api/pay/simulate` (server) verifies the caller owns the payment, then calls `confirm_payment()` with the **service role** key (`SUPABASE_SERVICE_ROLE_KEY`, server-only env var). `confirm_payment` is idempotent and marks a late payment `refund_due` instead of confirming an expired hold. Refund rules: full refund before the club cutoff or when staff flag club-caused; otherwise none. A real provider (Whish Pay / Areeba) replaces the simulate route with a redirect + server verification.

## Booking safety (do not weaken)

- `bookings.no_double_booking_court` / `_coach`: GiST exclusion on `(court_id, period)` for confirmed rows.
- `blocks.no_overlapping_blocks`: same on blocks.
- Triggers `bookings_block_check` / `blocks_booking_check`: cross-table overlap check, serialized by `select … from courts for update`.
- `bookings_slot_validation` trigger: inside opening hours, grid-aligned start, duration k × slot_minutes — for any source, insert or move.
- `hold_slot()`: validates club/court/duration/window, locks the court row, expires stale holds, inserts the pending booking + payment; exclusion constraint covers `confirmed` and `pending`.
- `(court_id, club_id)` composite FKs on bookings, blocks, price_rules: a court can only be used under its own club.
- Staff never UPDATE bookings directly: `move_booking()`, `cancel_booking()`, `mark_no_show()`.
- All RPCs: EXECUTE revoked from PUBLIC/anon, granted to `authenticated`. New functions must repeat this (Supabase default privileges grant anon).
- Cancellation policy: player may cancel any time; credit refunded only before the club cutoff (after it, the kept credit is the fee — MATCHi model). Staff cancellation refunds after the cutoff only when flagged club-caused (`cancel_booking(id, true)`); nobody can flag their own booking.
- Players never insert into `bookings` or `credit_transactions` directly (no RLS policy for it); they call the functions.
- `occupancy` view exposes slot times without names/phones; the grid reads it. Names only via `player_names(ids)`.

Run `supabase/tests/run.sh` against any local Postgres (needs `psql`) after touching the schema.

## Phase 0 setup (one-time)

1. **Supabase → SQL Editor → New query.** Paste each file in `supabase/migrations/` in order, Run each. Expect "Success. No rows returned".
2. Same for `supabase/seed.sql`.
3. **Supabase → Authentication → URL Configuration.** Site URL = your Vercel URL. Add `https://<vercel-url>/auth/callback` and `http://localhost:3000/auth/callback` to Redirect URLs.
4. **Vercel → New Project → import this repo.** Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable key) and `SUPABASE_SERVICE_ROLE_KEY` (the *secret* key; server-only, never `NEXT_PUBLIC_`). Deploy.
5. Open the URL on your phone → Sign in → email link → you should see "Batroun Padel & Tennis Club" with 5 courts.
6. Make yourself admin: SQL Editor →
   `update profiles set roles = '{player,admin}' where id = (select id from auth.users where email = 'you@example.com');`

## Local dev

```bash
cp .env.example .env.local   # fill in the anon key
npm install
npm run dev                  # http://localhost:3000
```

## Working method

One phase at a time, in the spec's order. One PR per feature; ChatGPT reviews; Paul tests on his phone against the spec's test column. Secrets live in environment variables, never in the repo.
