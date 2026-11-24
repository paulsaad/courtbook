-- Data snapshot — READ ONLY (SELECT only). Fingerprints of the rows a migration or a check must not change, for a
-- before/after comparison on staging (step 1 of docs/ops/release-candidate-staging.md, 24 Nov). Prints item|value;
-- no personal data is printed, only counts and md5 digests of key columns.
select 'bookings', count(*) || ' rows · ' || coalesce(md5(string_agg(concat_ws(',', id, status, court_id, club_id, player_id, start_at, end_at,
  price_usd, fee_usd, source, cancelled_at, guest_name, hold_expires_at), ';' order by id)), '-') from bookings
union all select 'bookings by status', coalesce(string_agg(s || '=' || n, ' ' order by s), '-')
  from (select status::text s, count(*) n from bookings group by status) x
union all select 'payments', count(*) || ' rows · ' || coalesce(md5(string_agg(concat_ws(',', id, booking_id, status, amount_usd, fee_usd, total_usd,
  provider, provider_ref, collected, note), ';' order by id)), '-') from payments
union all select 'payments by status', coalesce(string_agg(s || '=' || n, ' ' order by s), '-')
  from (select status::text s, count(*) n from payments group by status) x
union all select 'account_deletions', count(*) || ' rows · ' || coalesce(md5(string_agg(concat_ws(',', id, subject_id, status), ';' order by id)), '-') from account_deletions
union all select 'account_deletions by status', coalesce(string_agg(s || '=' || n, ' ' order by s), '-')
  from (select status::text s, count(*) n from account_deletions group by status) x
union all select 'profiles', count(*) || ' rows · ' || coalesce(md5(string_agg(id::text, ';' order by id)), '-') from profiles
union all select 'auth users', count(*) || ' rows · ' || coalesce(md5(string_agg(id::text, ';' order by id)), '-') from auth.users
union all select 'auth users left by auth_checks (auth-*@courtbook.test)', count(*)::text from auth.users where email like 'auth-%@courtbook.test'
union all select 'clubs and courts', (select count(*) from clubs) || ' clubs, ' || (select count(*) from courts) || ' courts · '
  || md5((select string_agg(concat_ws(',', id, active, payment_mode, service_fee_usd), ';' order by id) from clubs)
      || (select coalesce(string_agg(concat_ws(',', id, active), ';' order by id), '') from courts))
union all select 'calendar blocks', count(*) || ' rows · ' || coalesce(md5(string_agg(concat_ws(',', id, court_id, period), ';' order by id)), '-') from blocks;
