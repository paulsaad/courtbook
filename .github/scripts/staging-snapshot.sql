-- Read-only snapshot of staging data, to compare before and after a test run (18 Nov). Prints counts and
-- hashes only: no names, emails or password data. Run by the "check" action of "Staging database".
set default_transaction_read_only = on;
begin read only;
\pset format unaligned
\pset tuples_only on
select 'snapshot at ' || now();
select 'demo club: ' || name || ' (' || payment_mode || ')' from public.clubs where is_demo;
-- every public table: row count and a hash of all rows (updated_at left out: it changes on any touch)
select format($q$select 'table %1$s: ' || count(*) || ' rows, ' || coalesce(md5(string_agg((to_jsonb(t) - 'updated_at')::text, ',' order by (to_jsonb(t) - 'updated_at')::text)), '-') from public.%1$I t$q$, tablename)
  from pg_tables where schemaname = 'public' order by tablename
\gexec
-- accounts, without sign-in times
select 'auth.users: ' || count(*) || ' rows, ' || md5(string_agg(id::text || '|' || email || '|' || created_at::text, ',' order by id)) from auth.users;
select 'tester account (paul.tester): ' || count(*) || ' row, ' || coalesce(md5(string_agg(id::text || '|' || created_at::text || '|' || coalesce(email_confirmed_at::text, ''), ',')), '-')
  from auth.users where email = 'paul.tester@courtbook.test';
select 'tester bookings: ' || count(*) || ', ' || coalesce(md5(string_agg(to_jsonb(b)::text, ',' order by b.id)), '-')
  from public.bookings b join auth.users u on u.id = b.player_id where u.email = 'paul.tester@courtbook.test';
-- what an emulator run must leave behind: nothing
select 'e2e residue: users ' || (select count(*) from auth.users where email like 'e2e-android-%')
  || ', profiles ' || (select count(*) from public.profiles p join auth.users u on u.id = p.id where u.email like 'e2e-android-%')
  || ', bookings ' || (select count(*) from public.bookings b join auth.users u on u.id = b.player_id where u.email like 'e2e-android-%')
  || ', payments ' || (select count(*) from public.payments p join public.bookings b on b.id = p.booking_id join auth.users u on u.id = b.player_id where u.email like 'e2e-android-%');
commit;
