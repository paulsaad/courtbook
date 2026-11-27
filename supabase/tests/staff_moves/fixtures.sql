-- F1 fixtures (committed in the scratch database only): three Batroun people, one staff member of another club.
\set ON_ERROR_STOP 1
insert into auth.users (id, phone) values
  ('f7000000-0000-4000-8000-000000000001', '+96170700001'), ('f7000000-0000-4000-8000-000000000002', '+96170700002'),
  ('f7000000-0000-4000-8000-000000000003', '+96170700003'), ('f7000000-0000-4000-8000-000000000004', '+96170700004')
on conflict do nothing;
update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app',
  name = case id when 'f7000000-0000-4000-8000-000000000001' then 'Rana Khoury' when 'f7000000-0000-4000-8000-000000000002' then 'Maya Desk'
                      when 'f7000000-0000-4000-8000-000000000003' then 'Dina Desk' else 'Omar Other' end
 where id::text like 'f7000000%';
update clubs set payment_mode = 'at_desk' where slug = 'batroun';      -- Rana books "pay at the desk" (book_at_desk)
insert into club_staff (club_id, profile_id) select id, 'f7000000-0000-4000-8000-000000000002' from clubs where slug = 'batroun' on conflict do nothing;
insert into club_staff (club_id, profile_id) select id, 'f7000000-0000-4000-8000-000000000003' from clubs where slug = 'batroun' on conflict do nothing;
insert into clubs (name, slug) values ('Zz Other Club', 'zz-other') on conflict (slug) do nothing;
insert into courts (club_id, name, sport) select id, 'Other 1', 'padel' from clubs where slug = 'zz-other' on conflict do nothing;
insert into club_staff (club_id, profile_id) select id, 'f7000000-0000-4000-8000-000000000004' from clubs where slug = 'zz-other' on conflict do nothing;
