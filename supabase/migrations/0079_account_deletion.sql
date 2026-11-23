-- 0079 — Account deletion (master launch checklist M2; analysis "M2 account deletion: database impact analysis", Option A).
--
-- A person asks to delete their account (app, website, public page, or support email recorded by an admin). An admin
-- processes it (manual at launch): delete_account_data() runs in ONE transaction — cancels their upcoming games and
-- bookings under the normal rules, anonymises their bookings, deletes their chat messages, removes their coach listing
-- and anonymises the profile — then the server deletes the sign-in account (Supabase Auth admin API), which removes
-- the profile; every remaining reference becomes null. finish_account_deletion() confirms it. Re-running is safe.
--
-- Kept, anonymised (booking integrity, financial records): bookings (player → "Former player"), payments and credit
-- records (amounts, dates, club, provider reference; refunds still owed stay owed), finished games, club and staff
-- records. Kept (moderation evidence): reports — including those the person filed (reporter → null) and those about
-- them (snapshot text, legal hold; 180-day clearing is M6). Refused for manual handling: staff or admin roles (remove
-- the role first), a report about the person on legal hold, a coach with coach bookings.

-- ============ 1. references to profiles: keep the record, drop the person ============
alter table bookings            alter column created_by drop not null;
alter table payments            alter column profile_id drop not null;
alter table credit_transactions alter column profile_id drop not null;
alter table matches             alter column organizer_id drop not null;
alter table blocks              alter column created_by drop not null;
alter table club_payouts        alter column created_by drop not null;
alter table reports             alter column reporter_id drop not null;

do $$
declare r record;
begin
  for r in select * from (values
      ('bookings', 'player_id', 'bookings_player_id_fkey'),
      ('bookings', 'created_by', 'bookings_created_by_fkey'),
      ('payments', 'profile_id', 'payments_profile_id_fkey'),
      ('credit_transactions', 'profile_id', 'credit_transactions_profile_id_fkey'),
      ('credit_transactions', 'created_by', 'credit_transactions_created_by_fkey'),
      ('matches', 'organizer_id', 'matches_organizer_id_fkey'),
      ('notifications', 'actor_id', 'notifications_actor_id_fkey'),
      ('blocks', 'created_by', 'blocks_created_by_fkey'),
      ('club_media', 'created_by', 'club_media_created_by_fkey'),
      ('club_payouts', 'created_by', 'club_payouts_created_by_fkey'),
      ('coach_clubs', 'decided_by', 'coach_clubs_decided_by_fkey'),
      ('towns', 'created_by', 'towns_created_by_fkey'),
      ('account_suspensions', 'suspended_by', 'account_suspensions_suspended_by_fkey'),
      ('reports', 'handled_by', 'reports_handled_by_fkey'),
      ('reports', 'reporter_id', 'reports_reporter_id_fkey')   -- was CASCADE: reports the person filed are kept
    ) v(tbl, col, con) loop
    execute format('alter table %I drop constraint %I', r.tbl, r.con);
    execute format('alter table %I add constraint %I foreign key (%I) references profiles(id) on delete set null', r.tbl, r.con, r.col);
  end loop;
end $$;

-- chat messages go with their author (decision Q3: delete). A reported message keeps its report and snapshot text.
alter table match_messages drop constraint match_messages_profile_id_fkey;
alter table match_messages add constraint match_messages_profile_id_fkey
  foreign key (profile_id) references profiles(id) on delete cascade;

-- ============ 2. the request record ============
-- subject_id has no foreign key on purpose: after deletion it is an opaque id, and the row is the record that the
-- request was received and honoured (dates, counts). It holds no name, phone or email.
create table if not exists account_deletions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null,
  requested_at timestamptz not null default now(),
  requested_via text not null check (requested_via in ('app', 'web', 'support')),
  status text not null default 'requested' check (status in ('requested', 'cancelled', 'data_removed', 'done')),
  cancelled_at timestamptz,
  data_removed_at timestamptz,
  done_at timestamptz,
  processed_by uuid references profiles(id) on delete set null,
  summary jsonb
);
create unique index if not exists account_deletions_one_open on account_deletions (subject_id)
  where status in ('requested', 'data_removed');
alter table account_deletions enable row level security;
drop policy if exists "account_deletions: own or admin read" on account_deletions;
create policy "account_deletions: own or admin read" on account_deletions for select
  using (subject_id = auth.uid() or is_admin());
revoke insert, update, delete on account_deletions from anon, authenticated;

create or replace function deletion_requested(p_profile uuid) returns boolean
language sql stable security definer set search_path = public as $$
  -- 'data_removed' too: if the sign-in deletion is late, the still-signed-in person cannot start anything new
  select p_profile is not null and exists (select 1 from account_deletions where subject_id = p_profile and status in ('requested', 'data_removed'));
$$;
revoke all on function deletion_requested(uuid) from public, anon, authenticated;
grant execute on function deletion_requested(uuid) to service_role;

-- ============ 3. while a request is open: no new bookings, games, joins, chat messages or coach listings
--              (cancelling and leaving still work) ============
create or replace function block_new_activity_after_deletion_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_who uuid;
begin
  v_who := (to_jsonb(new) ->> tg_argv[0])::uuid;                 -- the column naming the person (trigger argument)
  if deletion_requested(v_who) then raise exception 'account_deletion_requested'; end if;
  return new;
end $$;
revoke all on function block_new_activity_after_deletion_request() from public, anon, authenticated;
drop trigger if exists bookings_deletion_guard on bookings;
create trigger bookings_deletion_guard before insert on bookings for each row execute function block_new_activity_after_deletion_request('player_id');
drop trigger if exists matches_deletion_guard on matches;
create trigger matches_deletion_guard before insert on matches for each row execute function block_new_activity_after_deletion_request('organizer_id');
drop trigger if exists match_players_deletion_guard on match_players;
create trigger match_players_deletion_guard before insert on match_players for each row execute function block_new_activity_after_deletion_request('profile_id');
drop trigger if exists match_messages_deletion_guard on match_messages;
create trigger match_messages_deletion_guard before insert on match_messages for each row execute function block_new_activity_after_deletion_request('profile_id');
drop trigger if exists coaches_deletion_guard on coaches;
create trigger coaches_deletion_guard before insert on coaches for each row execute function block_new_activity_after_deletion_request('profile_id');

-- ============ 3b. no shortcut: a profile with history is deleted only after delete_account_data ============
-- Deleting the sign-in account in the Supabase dashboard would otherwise skip the cancellations and anonymisation
-- (bookings would also hit their "player or guest name" check). The protections of delete_account_data hold here
-- too, for every account, with or without history: no admin, no club staff, nothing on legal hold, no coach with
-- coach bookings (remove the role or lift the hold first). An unused, unprotected sign-up can still be removed.
create or replace function profiles_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare refusal text;
begin
  refusal := deletion_refusal(old.id);
  if refusal is not null then raise exception 'use_delete_account: %', refusal; end if;
  if not exists (select 1 from account_deletions where subject_id = old.id and status = 'data_removed')
     and (exists (select 1 from bookings where player_id = old.id)
          or exists (select 1 from matches where organizer_id = old.id)
          or exists (select 1 from match_messages where profile_id = old.id)) then
    raise exception 'use_delete_account';
  end if;
  return old;
end $$;
revoke all on function profiles_delete_guard() from public, anon, authenticated;
drop trigger if exists profiles_delete_guard on profiles;
create trigger profiles_delete_guard before delete on profiles for each row execute function profiles_delete_guard();

-- ============ 4. the person's side ============
create or replace function deletion_refusal(p_subject uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from profiles where id = p_subject and 'admin' = any(roles)) then 'admin_role'
    when exists (select 1 from club_staff where profile_id = p_subject) then 'staff_role'
    when exists (select 1 from reports where legal_hold and (profile_id = p_subject or (target_kind = 'player' and target_key = p_subject))) then 'legal_hold'
    when exists (select 1 from bookings b join coaches co on co.id = b.coach_id where co.profile_id = p_subject) then 'coach_has_bookings'
  end;
$$;
revoke all on function deletion_refusal(uuid) from public, anon, authenticated;
grant execute on function deletion_refusal(uuid) to service_role;

create or replace function request_account_deletion(p_via text default 'app') returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_via not in ('app', 'web') then raise exception 'invalid_via'; end if;
  -- staff and admins: the role is removed first (a club must not lose its only desk account by surprise)
  if exists (select 1 from profiles where id = auth.uid() and 'admin' = any(roles)) then raise exception 'admin_role'; end if;
  if exists (select 1 from club_staff where profile_id = auth.uid()) then raise exception 'staff_role'; end if;
  select * into d from account_deletions where subject_id = auth.uid() and status in ('requested', 'data_removed');
  if not found then
    insert into account_deletions (subject_id, requested_via) values (auth.uid(), p_via) returning * into d;
  end if;
  return jsonb_build_object('status', d.status, 'requested_at', d.requested_at);
end $$;

create or replace function cancel_account_deletion() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update account_deletions set status = 'cancelled', cancelled_at = now()
   where subject_id = auth.uid() and status = 'requested';
  if not found then raise exception 'no_open_request'; end if;
end $$;

create or replace function my_account_deletion() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else
    (select jsonb_build_object('status', status, 'requested_at', requested_at)
       from account_deletions where subject_id = auth.uid() and status in ('requested', 'data_removed')) end;
$$;

revoke all on function request_account_deletion(text) from public, anon, authenticated;
revoke all on function cancel_account_deletion() from public, anon, authenticated;
revoke all on function my_account_deletion() from public, anon, authenticated;
grant execute on function request_account_deletion(text) to authenticated, service_role;
grant execute on function cancel_account_deletion() to authenticated, service_role;
grant execute on function my_account_deletion() to authenticated, service_role;

-- ============ 5. the admin's side ============
-- a request received by email to support (the person proved ownership of the address on the account)
create or replace function admin_record_deletion_request(p_subject uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if not exists (select 1 from profiles where id = p_subject) then raise exception 'not_found'; end if;
  insert into account_deletions (subject_id, requested_via) values (p_subject, 'support')
  on conflict (subject_id) where status in ('requested', 'data_removed') do nothing;
end $$;

create or replace function admin_account_deletions()
returns table (subject_id uuid, status text, requested_at timestamptz, requested_via text, name text, phone text,
               upcoming_bookings int, upcoming_games_organised int, open_reports_about int, refusal text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select d.subject_id, d.status, d.requested_at, d.requested_via, p.name, p.phone,
    (select count(*)::int from bookings b where b.player_id = d.subject_id and b.status in ('confirmed', 'pending') and b.start_at > now()),
    (select count(*)::int from matches m where m.organizer_id = d.subject_id and m.status <> 'cancelled' and m.start_at > now()),
    (select count(*)::int from reports r where r.status = 'open' and (r.profile_id = d.subject_id or (r.target_kind = 'player' and r.target_key = d.subject_id))),
    deletion_refusal(d.subject_id)
  from account_deletions d left join profiles p on p.id = d.subject_id
  where d.status in ('requested', 'data_removed')
  order by d.requested_at;
end $$;

-- the database part, in one transaction. Admin (signed in) or server context (auth.uid() null) only.
create or replace function delete_account_data(p_subject uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d account_deletions%rowtype;
  refusal text;
  r record;
  n_games int := 0; n_cancelled int := 0; n_refund int := 0; n_anon int; n_msgs int; n_left int; n_notes int;
  v_name text;
  susp jsonb;
  v_cutoff int;
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if p_subject is null then raise exception 'not_found'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('requested', 'data_removed') for update;
  if not found then raise exception 'no_open_request'; end if;
  -- Re-running after the data step is allowed and repeats it: every step only touches what is still there, so a
  -- second run changes nothing — unless something arrived in between (a hold that was being written while the first
  -- run ran), which it then cancels and anonymises too. The first run's counts are kept; a re-run is recorded.
  refusal := deletion_refusal(p_subject);
  if refusal is not null then raise exception '%', refusal; end if;

  -- Lock order, same as every other path: courts (sorted, as lock_courts does for move_booking and the desk), then
  -- games, then bookings, then payments. cancel_booking and the booking→game trigger take courts → booking → game,
  -- so taking every court first leaves no cycle with them.
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending')
       and (b.player_id = p_subject or b.id in (select m.booking_id from matches m where m.organizer_id = p_subject))), '{}'));
  select name into v_name from profiles where id = p_subject;

  -- (a) upcoming games they organise: cancelled, players told (before the bookings, so no "court lost" notices)
  for r in select * from matches where organizer_id = p_subject and status <> 'cancelled'
             and coalesce(end_at, start_at + interval '3 hours') > now() for update loop
    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;
    insert into notifications (profile_id, kind, match_id, body)
    select mp.profile_id, 'match_cancelled', r.id, 'Match cancelled: the organizer closed their account'
      from match_players mp where mp.match_id = r.id and mp.status in ('accepted', 'pending') and mp.profile_id <> p_subject;
    n_games := n_games + 1;
  end loop;

  -- (b) their future and pending bookings: cancelled under the same rules as cancel_booking (player side):
  --     pending → payment expired; paid and before the club's cutoff → refund due; inside the cutoff → no refund.
  --     Lock order as cancel_booking: court, then booking, then payments. Legacy credits are not re-issued.
  for r in select b.id, b.court_id, b.club_id from bookings b
             where b.player_id = p_subject
               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one
             order by b.start_at loop
    perform 1 from bookings where id = r.id for update;
    perform 1 from payments where booking_id = r.id for update;
    select cancel_cutoff_hours into v_cutoff from clubs where id = r.club_id;
    if (select status from bookings where id = r.id) = 'pending' then
      update payments set status = 'expired' where booking_id = r.id and status = 'pending';
    elsif (select start_at from bookings where id = r.id) - make_interval(hours => v_cutoff) > now() then
      update payments set status = 'refund_due', note = 'cancelled before cutoff (account deleted)'
       where booking_id = r.id and status = 'paid';
      get diagnostics n_left = row_count; n_refund := n_refund + n_left;
    end if;
    update bookings set status = 'cancelled', cancelled_at = now() where id = r.id;
    n_cancelled := n_cancelled + 1;
  end loop;

  -- (c) every booking of theirs stays as the club's and accounting record, anonymised
  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;
  get diagnostics n_anon = row_count;

  -- (d) chat messages deleted (a report keeps its snapshot); out of every game's player list
  delete from match_messages where profile_id = p_subject;
  get diagnostics n_msgs = row_count;
  -- leaving upcoming games of others as leave_match does: organiser told, a game closed only because it was full reopens
  for r in select m.*, mp.status as was from match_players mp join matches m on m.id = mp.match_id
             where mp.profile_id = p_subject and m.status <> 'cancelled' and m.start_at > now() for update of m loop
    delete from match_players where match_id = r.id and profile_id = p_subject;
    if r.was = 'accepted' then
      insert into notifications (profile_id, kind, match_id, body)
      select r.organizer_id, 'player_left', r.id, 'A player left your match' where r.organizer_id is not null;
      if r.status = 'closed' and r.closed_reason = 'full'
         and (select count(*) from match_players where match_id = r.id and status = 'accepted') < r.players_needed then
        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;
      end if;
    end if;
  end loop;
  delete from match_players where profile_id = p_subject;              -- past games: off the list too

  -- (d2) what others hold about them: chat excerpts in others' notifications go; their name in other notices becomes
  --      "A player"; notes on games they organised (free text: could hold a phone number) are cleared; their own
  --      Help & Feedback messages go (support, not moderation). Moderation reports and snapshots stay (evidence).
  delete from notifications where actor_id = p_subject and kind = 'match_message';
  if coalesce(btrim(v_name), '') <> '' then
    update notifications set body = regexp_replace(body, '\m' || regexp_replace(v_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M', 'A player', 'g')
     where actor_id = p_subject or body like '%' || v_name || '%' and match_id in (select id from matches where organizer_id = p_subject);
  end if;
  update matches set note = null where organizer_id = p_subject and note is not null;
  get diagnostics n_notes = row_count;
  delete from reports where reporter_id = p_subject and target_kind = 'feedback';

  -- (e) coach listing (no coach bookings, checked above); profile anonymised now in case the sign-in deletion is late
  delete from coaches where profile_id = p_subject;
  -- only the date: the reason is free text written about the person; it is kept (with its retention rule) in the
  -- moderation records, not in this permanent deletion record
  select jsonb_build_object('suspended_at', suspended_at) into susp from account_suspensions where profile_id = p_subject;
  update profiles set name = null, phone = null, level = null, sports = '{}', email_notifications = false where id = p_subject;

  if d.status = 'requested' then
    update account_deletions set status = 'data_removed', data_removed_at = now(), processed_by = auth.uid(),
      summary = jsonb_build_object('games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund,
                                   'bookings_anonymised', n_anon, 'messages_deleted', n_msgs, 'game_notes_cleared', n_notes, 'suspension', susp)
     where id = d.id returning summary into susp;
  else
    update account_deletions set summary = summary || jsonb_build_object('last_rerun', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'bookings_anonymised', n_anon, 'messages_deleted', n_msgs))
     where id = d.id returning summary into susp;
  end if;
  return susp;
end $$;

-- after the server has deleted the sign-in account (which removes the profile)
create or replace function finish_account_deletion(p_subject uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if exists (select 1 from profiles where id = p_subject) then raise exception 'account_still_exists'; end if;
  update account_deletions set status = 'done', done_at = now() where subject_id = p_subject and status = 'data_removed';
  if not found then raise exception 'no_removed_request'; end if;
end $$;

revoke all on function admin_record_deletion_request(uuid) from public, anon, authenticated;
revoke all on function admin_account_deletions() from public, anon, authenticated;
revoke all on function delete_account_data(uuid) from public, anon, authenticated;
revoke all on function finish_account_deletion(uuid) from public, anon, authenticated;
grant execute on function admin_record_deletion_request(uuid) to authenticated, service_role;
grant execute on function admin_account_deletions() to authenticated, service_role;
grant execute on function delete_account_data(uuid) to authenticated, service_role;
grant execute on function finish_account_deletion(uuid) to authenticated, service_role;
