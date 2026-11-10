-- Phase 5 review round 1.
-- #1 participation privacy  #2 idempotent join  #3 linked booking sync + sport check
-- #4 reopen only auto-closed  #5 decide_join only on open future matches  #6 atomic email claims

-- #1 --------------------------------------------------------------------------
-- security definer helper: a policy on match_players cannot query match_players itself (recursion)
create or replace function is_accepted_in_match(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from match_players where match_id = p_match and profile_id = auth.uid() and status = 'accepted');
$$;
revoke execute on function is_accepted_in_match(uuid) from public, anon;
grant execute on function is_accepted_in_match(uuid) to authenticated;

drop policy if exists "match_players: read" on match_players;
create policy "match_players: read" on match_players for select using (
  profile_id = auth.uid()
  or exists (select 1 from matches m where m.id = match_players.match_id and m.organizer_id = auth.uid())
  or (status = 'accepted' and is_accepted_in_match(match_id))
);

create or replace function player_names(p_ids uuid[])
returns table (id uuid, name text, level player_level, sports sport[])
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.sports
  from profiles p
  where auth.uid() is not null and cardinality(p_ids) <= 200 and p.id = any (p_ids)
    and (
      p.id = auth.uid()
      or exists (select 1 from bookings b where b.player_id = p.id and is_staff_of(b.club_id))
      -- I organize a match where p applied or is in
      or exists (select 1 from matches m join match_players mp on mp.match_id = m.id
                 where m.organizer_id = auth.uid() and mp.profile_id = p.id and mp.status in ('pending', 'accepted'))
      -- I am accepted in a match where p is the organizer or also accepted
      or exists (select 1 from matches m
                 join match_players me on me.match_id = m.id and me.profile_id = auth.uid() and me.status = 'accepted'
                 where m.organizer_id = p.id
                    or exists (select 1 from match_players them where them.match_id = m.id and them.profile_id = p.id and them.status = 'accepted'))
    );
$$;

-- #4 --------------------------------------------------------------------------
alter table matches add column if not exists closed_reason text check (closed_reason in ('full', 'organizer'));

-- #3 --------------------------------------------------------------------------
-- post_match: sport must match the booked court
create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level player_level,
  p_players_needed int, p_note text, p_booking uuid, p_join_mode text default 'open'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() and status = 'confirmed';
    if not found then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
end $$;

-- keep linked matches in sync with their booking
create or replace function sync_match_with_booking() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record; r record; who text;
begin
  for m in select * from matches where booking_id = new.id and status <> 'cancelled' loop
    if new.status <> 'confirmed' then
      -- booking cancelled / no-show: the court is no longer reserved
      update matches set booking_id = null where id = m.id;
      for r in select m.organizer_id as pid union select mp.profile_id from match_players mp where mp.match_id = m.id and mp.status = 'accepted' loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.pid, 'booking_unlinked', m.id, 'The court booking for your match was cancelled — the match is no longer linked to a court');
      end loop;
    elsif new.start_at <> old.start_at or new.end_at <> old.end_at or new.court_id is distinct from old.court_id then
      update matches set start_at = new.start_at, end_at = new.end_at where id = m.id;
      for r in select m.organizer_id as pid union select mp.profile_id from match_players mp where mp.match_id = m.id and mp.status = 'accepted' loop
        insert into notifications (profile_id, kind, match_id, body)
        values (r.pid, 'booking_moved', m.id, 'The club moved the court booking for your match — check the new time and court');
      end loop;
    end if;
  end loop;
  return new;
end $$;
drop trigger if exists bookings_sync_matches on bookings;
create trigger bookings_sync_matches
  after update of status, start_at, end_at, court_id on bookings
  for each row execute function sync_match_with_booking();

-- #2 / #4 ----------------------------------------------------------------------
create or replace function join_match(p_match uuid) returns text
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int; me text; cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;

  select status into cur from match_players where match_id = p_match and profile_id = auth.uid();
  if cur in ('accepted', 'pending') then return cur; end if;       -- idempotent
  if cur = 'declined' then raise exception 'join_declined'; end if; -- policy: no re-apply after a decline

  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending');
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted');
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
  end if;
  return 'accepted';
end $$;

-- #5
create or replace function decide_join(p_match uuid, p_profile uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'pending') then
    raise exception 'not_pending';
  end if;
  if p_accept then
    if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
    update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = p_profile;
    perform notify(p_profile, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
    if n + 1 >= m.players_needed then update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match; end if;
  else
    -- declining a stale request is allowed (cleans up), no notification if the match is gone
    update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
    if m.status = 'open' then perform notify(p_profile, 'join_declined', p_match, 'The organizer could not take you for this match'); end if;
  end if;
end $$;

create or replace function leave_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; was text; me text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  select status into was from match_players where match_id = p_match and profile_id = auth.uid();
  delete from match_players where match_id = p_match and profile_id = auth.uid();
  if was = 'accepted' then
    select coalesce(name, 'A player') into me from profiles where id = auth.uid();
    perform notify(m.organizer_id, 'player_left', p_match, me || ' left your match');
    if m.status = 'closed' and m.closed_reason = 'full'
       and (select count(*) from match_players where match_id = p_match and status = 'accepted') < m.players_needed then
      update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
    end if;
  end if;
end $$;

create or replace function set_match_status(p_match uuid, p_status match_status) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; r record;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if p_status = 'open' and m.status = 'cancelled' then raise exception 'cannot_reopen'; end if;
  update matches set status = p_status,
    closed_at = case when p_status = 'open' then null else now() end,
    closed_reason = case when p_status = 'closed' then 'organizer' else null end
  where id = p_match;
  if p_status = 'cancelled' then
    for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
      perform notify(r.profile_id, 'match_cancelled', p_match, 'Match cancelled by the organizer');
    end loop;
  end if;
end $$;

-- #6 --------------------------------------------------------------------------
alter table notifications add column if not exists email_claimed_at timestamptz;

-- atomically claim a batch; stale claims (> 5 min, not emailed) are reclaimable
create or replace function claim_notifications_to_email(p_limit int)
returns table (id uuid, email text, name text, body text, kind text, match_id uuid)
language sql security definer set search_path = public as $$
  with picked as (
    select n.id from notifications n join profiles p on p.id = n.profile_id
    where n.emailed_at is null and p.email_notifications
      and (n.email_claimed_at is null or n.email_claimed_at < now() - interval '5 min')
    order by n.created_at limit least(p_limit, 50)
    for update of n skip locked
  ),
  claimed as (
    update notifications n set email_claimed_at = now() from picked where n.id = picked.id returning n.id
  )
  select n.id, u.email::text, p.name, n.body, n.kind, n.match_id
  from claimed c join notifications n on n.id = c.id join profiles p on p.id = n.profile_id join auth.users u on u.id = p.id
  where u.email is not null;
$$;
revoke execute on function claim_notifications_to_email(int) from public, anon, authenticated;
grant execute on function claim_notifications_to_email(int) to service_role;
drop function if exists notifications_to_email(int);
