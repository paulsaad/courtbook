# CourtBook

Mobile-first PWA for booking sports courts, coaches and finding players. Piloting in North Lebanon.
Spec: *Court booking app — product spec v0.1* (project knowledge).

Stack: Next.js (TypeScript) · Supabase (Postgres, RLS, auth) · Vercel · GitHub.

## Layout

| Path | What |
| --- | --- |
| `supabase/migrations/0001_init.sql` | Full schema: tables, enums, double-booking guards, `book_slot` / `cancel_booking`, RLS |
| `supabase/seed.sql` | Demo club (Batroun), 5 courts, peak/off-peak prices, credit packs. Idempotent |
| `supabase/tests/run.sh` | Local Postgres test: concurrent double-booking, blocks, credits, RLS |
| `src/lib/supabase/` | Browser and server Supabase clients |
| `src/app/` | Pages: `/` (clubs), `/login` (email link), `/auth/callback`, `/auth/signout` |

## Booking safety (do not weaken)

- `bookings.no_double_booking_court` / `_coach`: GiST exclusion on `(court_id, period)` for confirmed rows.
- `blocks.no_overlapping_blocks`: same on blocks.
- Triggers `bookings_block_check` / `blocks_booking_check`: cross-table overlap check, serialized by `select … from courts for update`.
- `book_slot()`: credit debit + booking insert in one transaction; a rejected booking never costs a credit.
- Players never insert into `bookings` or `credit_transactions` directly (no RLS policy for it); they call the functions.
- `occupancy` view exposes slot times without names/phones; the grid reads it.

Run `supabase/tests/run.sh` against any local Postgres (needs `psql`) after touching the schema.

## Phase 0 setup (one-time)

1. **Supabase → SQL Editor → New query.** Paste `supabase/migrations/0001_init.sql`, Run. Expect "Success. No rows returned".
2. Same for `supabase/seed.sql`.
3. **Supabase → Authentication → URL Configuration.** Site URL = your Vercel URL. Add `https://<vercel-url>/auth/callback` and `http://localhost:3000/auth/callback` to Redirect URLs.
4. **Vercel → New Project → import this repo.** Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase → Project Settings → API). Deploy.
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
