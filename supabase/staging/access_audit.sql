-- M12.4 staging plan, condition 2 (24 Nov): before the staging-web alias is opened to the public, establish that
-- staging holds no inappropriate personal data and no production data. READ ONLY (run with
-- default_transaction_read_only = on, through .github/scripts/run-check.sh <db> this-file all).
--
-- The workflow log is public, so this prints NO email address, phone number, name (people's or clubs'), message
-- text, file name or account id beyond its first 8 characters. Test addresses (@courtbook.test) count as test accounts; any other address is a
-- personal one and FAILS its row: a person decides what happens to it (nothing here changes anything).
-- Rows: item | ok | detail.
with u as (
  select u.id, coalesce(u.email, '') as email, u.phone,
         u.email like '%@courtbook.test' as test,
         coalesce(u.raw_app_meta_data->>'provider', '?') as provider,
         u.created_at, u.last_sign_in_at
  from auth.users u
), p as (select * from profiles)
select 'A1 accounts (all)', true,
       format('%s total: %s test (@courtbook.test), %s other address, %s without email; providers %s',
              count(*), count(*) filter (where test), count(*) filter (where not test and email <> ''),
              count(*) filter (where email = ''),
              coalesce((select string_agg(provider || '=' || n, ' ' order by provider) from (select provider, count(*) n from u group by provider) x), '-'))
from u
union all
select 'A2 accounts with a personal (non-test) address — each needs your decision', count(*) = 0,
       coalesce(string_agg(format('%s… via %s, created %s, last sign-in %s, roles %s, bookings %s',
         left(u.id::text, 8), u.provider, to_char(u.created_at, 'YYYY-MM-DD'), coalesce(to_char(u.last_sign_in_at, 'YYYY-MM-DD'), 'never'),
         coalesce((select array_to_string(roles, '+') from p where p.id = u.id), '-'),
         (select count(*) from bookings b where b.player_id = u.id)), '; ' order by u.created_at), 'none')
from u where not u.test
union all
select 'A3 phone numbers stored on accounts or profiles', count(*) = 0, format('%s', count(*))
from (select id from u where coalesce(phone, '') <> '' union select id from p where coalesce(phone, '') <> '') x
union all
select 'A4 names on accounts with a personal address (test names are expected)', count(*) = 0, format('%s', count(*))
from p join u on u.id = p.id where not u.test and coalesce(p.name, '') <> ''
union all
select 'B1 phone numbers typed in at the desk (bookings.guest_phone)', count(*) = 0, format('%s', count(*))
from bookings where coalesce(guest_phone, '') <> ''
union all
select 'B2 free text written by accounts with a personal address (game messages, reports, coach bios)',
       (m + r + c) = 0, format('messages %s, reports %s, coach profiles %s', m, r, c)
from (select (select count(*) from match_messages x join u on u.id = x.profile_id where not u.test) m,
             (select count(*) from reports x join u on u.id = x.reporter_id where not u.test) r,
             (select count(*) from coaches x join u on u.id = x.profile_id where not u.test) c) t
union all
select 'C1 clubs that are not demo clubs (production data would show here)', count(*) filter (where not is_demo) = 0,
       format('%s clubs: %s demo (%s active), %s not demo (%s active)', count(*),
              count(*) filter (where is_demo), count(*) filter (where is_demo and active),
              count(*) filter (where not is_demo), count(*) filter (where not is_demo and active))
from clubs
union all
-- Any stored file fails this row: its content must be reviewed by a person (in the dashboard, not here) before the
-- alias is exposed. Counts only: no file name, path or content. 'club-media' is the only bucket our migrations
-- create (0056); any other bucket is counted together, without its name.
select 'C2 stored files — any file needs its content reviewed before the alias is exposed', count(*) = 0,
       format('club-media: %s files; other buckets: %s files in %s buckets', count(*) filter (where bucket_id = 'club-media'),
              count(*) filter (where bucket_id <> 'club-media'), count(distinct bucket_id) filter (where bucket_id <> 'club-media'))
from storage.objects
union all
select 'D1 money: payments or fee charges marked collected, or any real provider', (a + b + c) = 0,
       format('payments collected %s, fee charges collected %s, non-simulated provider rows %s', a, b, c)
from (select (select count(*) from payments where collected) a,
             -- fee_charges / payment_attempts exist only from 0094: counted only if present, so this runs before 0094 too
             case when to_regclass('public.fee_charges') is null then 0
                  else (xpath('/row/n/text()', query_to_xml('select count(*) as n from fee_charges where collected', false, true, '')))[1]::text::int end b,
             (select count(*) from payments where provider <> 'simulated')
             + case when to_regclass('public.payment_attempts') is null then 0
                    else (xpath('/row/n/text()', query_to_xml('select count(*) as n from payment_attempts where provider <> ' || quote_literal('simulated'), false, true, '')))[1]::text::int end c) t;
