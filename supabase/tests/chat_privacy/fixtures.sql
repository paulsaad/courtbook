-- Legacy state, made with the CURRENT (0074) chat trigger, which copies message text into notices. Committed into the
-- scratch database so the preflight, the draft, the postcheck and the tests all see it.
\set ON_ERROR_STOP 1
\ir helpers.sql
insert into auth.users (id, phone, email) select pg_temp.u(n), '+9617665000' || lpad(n::text, 2, '0'), 'p' || n || '@example.test' from generate_series(1, 5) n;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app',
  name = (array['Karim Haddad', 'Rana Khoury', 'Lea Saad', 'Sami Aoun', 'Admin'])[right(id::text, 1)::int]
where id in (select pg_temp.u(n) from generate_series(1, 5) n);
update profiles set roles = '{player,admin}' where id = pg_temp.u(5);
update profiles set email_notifications = true where id in (pg_temp.u(1), pg_temp.u(2));   -- Karim and Rana get emails
update profiles set email_notifications = false where id in (pg_temp.u(3), pg_temp.u(4), pg_temp.u(5));
select pg_temp.r(pg_temp.u(1), format('select post_match(%L, ''padel'', %L, %L, null, null, 3, ''zz-chatpriv-' || d || ''', null, ''open'', null)::text',
  (select id from clubs where slug = 'batroun'), pg_temp.at(d + 2, '18:00'), pg_temp.at(d + 2, '19:30'))) from generate_series(1, 2) d;
select pg_temp.r(pg_temp.u(2), format('select join_match(%L)', pg_temp.game(1)));
select pg_temp.r(pg_temp.u(3), format('select join_match(%L)', pg_temp.game(1)));
select pg_temp.r(pg_temp.u(2), format('select join_match(%L)', pg_temp.game(2)));
-- 1. a message its sender deleted
select pg_temp.r(pg_temp.u(1), format('select delete_match_message(%L)', pg_temp.say(1, pg_temp.game(1), 'my private address is 12 Cedar St')));
update notifications set read_at = now() where match_id = pg_temp.game(1);
-- 2. a message Rana reported and an admin hid (the report keeps the text as evidence)
select pg_temp.say(1, pg_temp.game(1), 'call me on 70 123 456');
select pg_temp.r(pg_temp.u(2), format('select report_content(''message'', %L, ''inappropriate'')', (select id from match_messages where body = 'call me on 70 123 456')));
select pg_temp.r(pg_temp.u(5), format('select admin_hide_message(%L)', (select id from match_messages where body = 'call me on 70 123 456')));
-- 3. a grouped notice: Lea writes while Rana's notice is unread (no new notice for Rana; Karim gets one)
select pg_temp.say(3, pg_temp.game(1), 'see you at six');
-- 4. a live message in the second game
select pg_temp.say(1, pg_temp.game(2), 'gate code 4321');
