-- READ ONLY inspection of the live database after the 0065 preflight differences (2026-11-14).
-- One SELECT, changes nothing. Answers: is the code difference only line endings? does the database
-- still refuse overlapping and invalid bookings? would the missing migrations touch existing data?
with fn as (
  select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig, p.prosrc
  from pg_proc p where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
),
baseline(sig, h) as (values
('add_club_gallery(p_actor uuid, p_club uuid, p_path text, p_caption text, p_width integer, p_height integer)','f53498544ff6'),
('add_club_staff(p_club uuid, p_email text)','29d0e4349be5'),
('add_town(p_district text, p_name_en text, p_name_ar text)','357d65a26017'),
('areas()','0c9c7c6821bf'),
('assert_club_editor(p_club uuid)','08b71bf203c1'),
('assert_club_editor_as(p_actor uuid, p_club uuid)','a79f8fbee8ea'),
('assert_media_path(p_club uuid, p_path text)','c25149038171'),
('assert_valid_court_slot(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)','842d14da3389'),
('book_at_desk(p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_token uuid)','2c6a804f80d0'),
('booking_match(p_booking uuid)','b91a2b05ecd4'),
('bookings_validate_slot()','4658300d91e8'),
('cancel_booking(p_booking uuid, p_club_caused boolean)','8755cbc4b17e'),
('claim_notifications_to_email(p_limit integer)','f62783ef40a7'),
('claim_payment_session(p_payment uuid)','9f21d083ee69'),
('clear_notifications()','d4a1e9679a76'),
('close_club(p_club uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_reason text)','5374dc2a4933'),
('club_balances()','06d113eacdaa'),
('club_booking_contacts(p_club uuid, p_bookings uuid[])','3053c751e2e6'),
('club_coach_requests(p_club uuid)','a96f243dc2a9'),
('club_common_duration(p_club uuid)','ed9bc4e50567'),
('club_courts_free_now(p_club uuid)','8a8aa55a84a8'),
('club_day_slots(p_date date, p_sport sport, p_governorate text, p_district text, p_query text)','35ff8264c576'),
('club_discovery(p_sport sport, p_governorate text, p_district text, p_query text)','aba9a60d5ec0'),
('club_media_sync_cover()','bce21aea9495'),
('club_recent_guests(p_club uuid, p_query text)','8181803334bb'),
('club_sports(p_club uuid)','82126283b770'),
('club_staff_list(p_club uuid)','531b596a238e'),
('coach_availability(p_coach uuid, p_club uuid, p_from date, p_days integer)','6f096de16d4c'),
('coach_card(p_coach uuid)','d385a667f7dc'),
('coach_listed_at(p_coach uuid, p_club uuid)','7b209e1a73d5'),
('coaches_at_club(p_club uuid)','8359adcb59ab'),
('coaches_directory(p_governorate text, p_district text)','66c5da8e2a1c'),
('confirm_payment(p_payment uuid, p_provider_ref text, p_total_usd numeric)','5d6c65734d59'),
('credit_balance(p_profile uuid)','accd213ade15'),
('decide_coach_club(p_coach uuid, p_club uuid, p_approve boolean)','b751f9880295'),
('decide_join(p_match uuid, p_profile uuid, p_accept boolean)','bce21b2e4e71'),
('delete_match_message(p_id uuid)','71987315f91d'),
('delete_notification(p_id uuid)','656e0c4ee219'),
('expire_stale_holds(p_court uuid)','bd5333a93306'),
('fail_payment(p_payment uuid, p_note text)','9e6af7417147'),
('handle_new_user()','b675269d53c8'),
('hide_match(p_match uuid, p_hidden boolean)','2b82cb7dbcd1'),
('hold_slot(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)','93fa689d8321'),
('is_accepted_in_match(p_match uuid)','19d6577f7b6e'),
('is_admin()','2f05e4d9c72f'),
('is_in_match(p_match uuid)','6c0c093acbde'),
('is_match_member(p_match uuid)','e706cd38eafc'),
('is_staff_of(p_club uuid)','2fd33ea36233'),
('join_match(p_match uuid)','07d5432f9f20'),
('leave_match(p_match uuid)','db6bb484d827'),
('level_group(p_level integer)','38c8548d8fb9'),
('level_range_of(p_level player_level)','005f524fa86d'),
('lock_courts(p_courts uuid[])','bc14911ae00e'),
('mark_no_show(p_booking uuid)','c10331035656'),
('mark_notifications_emailed(p_ids uuid[])','4409b99ab8b3'),
('mark_notifications_read(p_ids uuid[])','d8b917c2aa34'),
('mark_refunded(p_payment uuid)','c2395c70a1da'),
('match_board(p_club uuid, p_days integer)','7ee31e25c3b9'),
('match_is_hidden(p_match uuid)','c889f97c3fd8'),
('match_level_bounds(m matches)','d66bbb61529a'),
('match_message_notify()','485b766738b9'),
('match_messages_list(p_match uuid, p_after timestamp with time zone)','c0159407235a'),
('match_participants(p_match uuid)','c380fb118214'),
('media_orphans_list()','96e66c97537a'),
('move_booking(p_booking uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)','8738160b4251'),
('my_active_hold()','421a9384bf71'),
('my_agenda()','82552d9db64f'),
('my_coach_id()','951c5cbf9f53'),
('my_levels()','6fa3e8fd2c92'),
('next_free_slot(p_club uuid, p_sport sport)','77cb57f78bc8'),
('notify(p_profile uuid, p_kind text, p_match uuid, p_body text)','b09a3631a11f'),
('open_matches(p_sport sport, p_fit text, p_from timestamp with time zone, p_to timestamp with time zone, p_governorate text, p_district text, p_limit integer)','fe591842860b'),
('payments_block_at_desk()','9bd46c0a459c'),
('payments_list(p_club uuid, p_month date)','53373956c9ad'),
('payments_summary(p_month date)','fedec968efb3'),
('player_names(p_ids uuid[])','795473f9e11b'),
('post_match(p_club uuid, p_sport sport, p_start timestamp with time zone, p_end timestamp with time zone, p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid, p_join_mode text)','548b94f7c81c'),
('price_rules_no_overlap()','702d66445cfa'),
('protect_profile_roles()','f6f2c8037029'),
('quote_price(p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone)','eafe80fffbc3'),
('record_club_payout(p_club uuid, p_amount numeric, p_method text, p_reference text)','70038a09947c'),
('record_media_orphan(p_actor uuid, p_club uuid, p_path text, p_reason text, p_certain boolean)','241c800226fc'),
('refunds_due()','643e8b100125'),
('reject_block_over_booking()','18c335039c80'),
('reject_booking_over_block()','1c955f6aaf4e'),
('release_hold(p_booking uuid)','487e15c1d0ec'),
('release_payment_session_claim(p_payment uuid)','6e7919281557'),
('remove_club_media(p_actor uuid, p_id uuid)','00828496918c'),
('remove_club_staff(p_club uuid, p_profile uuid)','5ad089946213'),
('reorder_club_gallery(p_actor uuid, p_club uuid, p_ids uuid[])','2685e9869957'),
('set_club_image(p_actor uuid, p_club uuid, p_kind text, p_path text, p_width integer, p_height integer, p_expect uuid)','9989ab6d8e77'),
('set_club_payment_mode(p_club uuid, p_mode text)','ffd87dcbedbf'),
('set_club_venue(p_club uuid, p_description text, p_arrival text, p_address text, p_parking boolean, p_changing boolean, p_showers boolean, p_rental boolean, p_cafe boolean, p_floodlights boolean, p_water boolean)','32b4518e106f'),
('set_gallery_caption(p_actor uuid, p_id uuid, p_caption text)','5d1ec3957197'),
('set_match_status(p_match uuid, p_status match_status)','68feb36c10f7'),
('set_player_level(p_sport sport, p_level integer)','c5b54ff08696'),
('staff_book(p_club uuid, p_court uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_name text, p_phone text)','1e2c0a9731be'),
('storage_public_url(p_path text)','5249aca997ae'),
('sync_match_with_booking()','791e9d4948f6'),
('update_club_settings(p_club uuid, p_open time without time zone, p_close time without time zone, p_slot integer, p_min integer, p_max integer, p_cutoff integer, p_hold integer, p_window integer, p_location text, p_town uuid, p_lat numeric, p_lng numeric)','ba2c442936ea'),
('update_match(p_match uuid, p_players_needed integer, p_level_min integer, p_level_max integer, p_note text, p_join_mode text)','aa37b42e834a')
),
norm as (
  select f.sig, left(md5(regexp_replace(f.prosrc, '[ \t\r]+(\n|$)', '\1', 'g')), 12) as h from fn f
),
active as (
  select b.id, b.court_id, b.club_id, b.start_at, b.end_at, b.status, c.slot_minutes, c.open_time, c.close_time, c.timezone,
         extract(epoch from (b.end_at - b.start_at)) as dur_s,
         (b.start_at at time zone c.timezone) as l_start, (b.end_at at time zone c.timezone) as l_end
  from bookings b join clubs c on c.id = b.club_id
  where b.status in ('confirmed', 'pending') and b.court_id is not null
),
invalid as (
  -- the same rules as assert_valid_court_slot (what the missing trigger would check)
  select a.*,
    case
      when not exists (select 1 from courts k where k.id = a.court_id and k.club_id = a.club_id) then 'court_not_found'
      when a.dur_s <= 0 or a.dur_s % (a.slot_minutes * 60) <> 0 then 'bad_duration'
      when a.l_start <> date_trunc('minute', a.l_start) then 'not_on_grid'
      when extract(epoch from (a.l_start - date_trunc('day', a.l_start))) / 60 < extract(epoch from a.open_time) / 60
        or extract(epoch from (a.l_end - date_trunc('day', a.l_start))) / 60 > extract(epoch from a.close_time) / 60 then 'outside_opening_hours'
      when ((extract(epoch from (a.l_start - date_trunc('day', a.l_start))) / 60)::int - (extract(epoch from a.open_time) / 60)::int) % a.slot_minutes <> 0 then 'not_on_grid'
    end as reason
  from active a
),
rows(n, item, value) as (
  select 1, 'functions: total / with Windows line endings (CR)', count(*) || ' / ' || count(*) filter (where prosrc like '%' || chr(13) || '%') from fn
  union all
  select 2, 'functions identical to the repository once line endings and trailing spaces are ignored',
         count(*) filter (where n.h = b.h) || ' of ' || count(*) from norm n join baseline b using (sig)
  union all
  select 3, 'functions NOT identical even then (name)', coalesce(string_agg(n.sig, '; ' order by n.sig), 'none') from norm n join baseline b using (sig) where n.h <> b.h
  union all
  select 4, 'overlap protection on bookings (exclusion constraints)',
         coalesce(string_agg(conname || ': ' || pg_get_constraintdef(oid), ' || ' order by conname), 'NONE') from pg_constraint where conrelid = 'public.bookings'::regclass and contype = 'x'
  union all
  select 5, 'active court bookings that overlap each other (pairs)',
         (select count(*) from active a join active b on a.court_id = b.court_id and a.id < b.id and a.start_at < b.end_at and b.start_at < a.end_at)::text
  union all
  select 6, 'active court bookings (confirmed or held) / of which break the slot rules', (select count(*) from active) || ' / ' || (select count(*) from invalid where reason is not null)
  union all
  select 7, 'rule-breaking bookings in the future (id, start, reason)',
         coalesce((select string_agg(id || ' ' || to_char(start_at at time zone timezone, 'YYYY-MM-DD HH24:MI') || ' ' || reason, '; ' order by start_at) from invalid where reason is not null and end_at > now()), 'none')
  union all
  select 8, 'rule-breaking bookings in the past (count)', (select count(*) from invalid where reason is not null and end_at <= now())::text
  union all
  select 9, 'coach availability exceptions: total / migration 0023 would keep / would delete',
         (select count(*) from availability_exceptions) || ' / ' ||
         (select count(*) from availability_exceptions e where e.coach_id in (select coach_id from coach_clubs where status = 'approved' group by coach_id having count(*) = 1)) || ' / ' ||
         (select count(*) from availability_exceptions e where e.coach_id not in (select coach_id from coach_clubs where status = 'approved' group by coach_id having count(*) = 1))
  union all
  select 10, 'coach-club links with status removed / declined (affected by 0021)',
         (select count(*) filter (where status = 'removed') || ' / ' || count(*) filter (where status = 'declined') from coach_clubs)
  union all
  select 11, 'book_slot function exists (an older 0004 object; information)', exists (select 1 from pg_proc where proname = 'book_slot' and pronamespace = 'public'::regnamespace)::text
  union all
  select 12, 'server', current_setting('server_version')
)
select n as "#", item, value from rows order by n;
