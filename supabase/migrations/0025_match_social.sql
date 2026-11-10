-- Phase 5b (Paul, 2026-11-10): join approval, match chat, in-app notifications.

-- ---------------------------------------------------------------------------
-- Join approval
-- ---------------------------------------------------------------------------
alter table matches add column if not exists join_mode text not null default 'open' check (join_mode in ('open', 'approval'));
alter table match_players add column if not exists status text not null default 'accepted' check (status in ('pending', 'accepted', 'declined'));
alter table match_players add column if not exists decided_at timestamptz;

-- ---------------------------------------------------------------------------
-- Notifications (in-app; the app may also email them)
-- ---------------------------------------------------------------------------
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  kind        text not null,                -- join_request, join_accepted, join_declined, player_left, match_cancelled, match_message
  match_id    uuid references matches(id) on delete cascade,
  actor_id    uuid references profiles(id),
  body        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  emailed_at  timestamptz
);
create index notifications_profile_idx on notifications (profile_id, created_at desc);
alter table notifications enable row level security;
create policy "notifications: own read" on notifications for select using (profile_id = auth.uid());
create policy "notifications: own mark read" on notifications for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

alter table profiles add column if not exists email_notifications boolean not null default true;

create or replace function notify(p_profile uuid, p_kind text, p_match uuid, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into notifications (profile_id, kind, match_id, actor_id, body)
  select p_profile, p_kind, p_match, auth.uid(), p_body where p_profile is not null and p_profile <> auth.uid();
$$;
revoke execute on function notify(uuid, text, uuid, text) from public, anon, authenticated;

create or replace function mark_notifications_read(p_ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update notifications set read_at = now() where profile_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
$$;
revoke execute on function mark_notifications_read(uuid[]) from public, anon;
grant execute on function mark_notifications_read(uuid[]) to authenticated;

-- Unemailed notifications for recipients who opted in; the server route emails and stamps them.
create or replace function notifications_to_email(p_limit int)
returns table (id uuid, email text, name text, body text, kind text, match_id uuid)
language sql stable security definer set search_path = public as $$
  select n.id, u.email::text, p.name, n.body, n.kind, n.match_id
  from notifications n join profiles p on p.id = n.profile_id join auth.users u on u.id = p.id
  where n.emailed_at is null and p.email_notifications and u.email is not null
  order by n.created_at limit least(p_limit, 50);
$$;
revoke execute on function notifications_to_email(int) from public, anon, authenticated;
grant execute on function notifications_to_email(int) to service_role;
create or replace function mark_notifications_emailed(p_ids uuid[]) returns void
language sql security definer set search_path = public as $$
  update notifications set emailed_at = now() where id = any (p_ids);
$$;
revoke execute on function mark_notifications_emailed(uuid[]) from public, anon, authenticated;
grant execute on function mark_notifications_emailed(uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Match RPCs under approval mode
-- ---------------------------------------------------------------------------
create or replace function post_match(
  p_club uuid, p_sport sport, p_start timestamptz, p_end timestamptz, p_level player_level,
  p_players_needed int, p_note text, p_booking uuid, p_join_mode text default 'open'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() and status = 'confirmed';
    if not found then raise exception 'booking_not_found'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level, players_needed, note, booking_id, join_mode)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode);
  return v_id;
end $$;
drop function if exists post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid);
revoke execute on function post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid, text) from public, anon;
grant execute on function post_match(uuid, sport, timestamptz, timestamptz, player_level, int, text, uuid, text) to authenticated;

drop function if exists join_match(uuid);
create or replace function join_match(p_match uuid) returns text
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int; me text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending')
    on conflict (match_id, profile_id) do update set status = 'pending', decided_at = null;
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted')
  on conflict (match_id, profile_id) do update set status = 'accepted', decided_at = now();
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now() where id = p_match;
  end if;
  return 'accepted';
end $$;

create or replace function decide_join(p_match uuid, p_profile uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int; who text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'pending') then
    raise exception 'not_pending';
  end if;
  if p_accept then
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
    update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = p_profile;
    perform notify(p_profile, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
    if n + 1 >= m.players_needed then update matches set status = 'closed', closed_at = now() where id = p_match; end if;
  else
    update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
    perform notify(p_profile, 'join_declined', p_match, 'The organizer could not take you for this match');
  end if;
  select coalesce(name, '') into who from profiles where id = p_profile;
end $$;
revoke execute on function join_match(uuid) from public, anon;
grant execute on function join_match(uuid) to authenticated;
revoke execute on function decide_join(uuid, uuid, boolean) from public, anon;
grant execute on function decide_join(uuid, uuid, boolean) to authenticated;

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
    if m.status = 'closed' and m.closed_at is not null
       and (select count(*) from match_players where match_id = p_match and status = 'accepted') < m.players_needed then
      update matches set status = 'open', closed_at = null where id = p_match and status = 'closed';
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
  update matches set status = p_status, closed_at = case when p_status = 'open' then null else now() end where id = p_match;
  if p_status = 'cancelled' then
    for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
      perform notify(r.profile_id, 'match_cancelled', p_match, 'Match cancelled by the organizer');
    end loop;
  end if;
end $$;

-- board: joined counts accepted only; include my pending state
drop function match_board(uuid, int);
create or replace function match_board(p_club uuid, p_days int)
returns table (
  match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamptz, end_at timestamptz,
  level player_level, players_needed int, joined int, pending int, status match_status, note text, join_mode text,
  organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text
)
language sql stable security definer set search_path = public as $$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at, m.level, m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.note, m.join_mode, m.organizer_id, o.name,
         (select mp.status from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()),
         m.organizer_id = auth.uid(),
         m.booking_id, k.name
  from matches m
  left join clubs c on c.id = m.club_id
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  where auth.uid() is not null
    and (p_club is null or m.club_id = p_club)
    and m.start_at > now() and m.start_at < now() + make_interval(days => coalesce(p_days, 14))
    and (m.status = 'open' or m.organizer_id = auth.uid() or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()))
  order by m.start_at;
$$;
revoke execute on function match_board(uuid, int) from public, anon;
grant execute on function match_board(uuid, int) to authenticated;

-- participants: organizer sees everyone incl. pending; accepted players see organizer + accepted
drop function match_participants(uuid);
create or replace function match_participants(p_match uuid)
returns table (profile_id uuid, name text, level player_level, is_organizer boolean, status text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.id = m.organizer_id, coalesce(mp.status, 'accepted')
  from matches m
  join lateral (
    select m.organizer_id as pid, null::text as st
    union all
    select x.profile_id, x.status from match_players x where x.match_id = m.id and x.status in ('accepted', 'pending')
  ) ids on true
  join profiles p on p.id = ids.pid
  left join match_players mp on mp.match_id = m.id and mp.profile_id = ids.pid
  where m.id = p_match and auth.uid() is not null
    and (m.organizer_id = auth.uid()
         or exists (select 1 from match_players y where y.match_id = m.id and y.profile_id = auth.uid() and y.status = 'accepted'))
    and (m.organizer_id = auth.uid() or coalesce(mp.status, 'accepted') = 'accepted')
  order by (p.id = m.organizer_id) desc, coalesce(mp.status, 'accepted'), p.name;
$$;
revoke execute on function match_participants(uuid) from public, anon;
grant execute on function match_participants(uuid) to authenticated;

-- player_names: pending requesters count as sharing the match (organizer must see their name)
create or replace function player_names(p_ids uuid[])
returns table (id uuid, name text, level player_level, sports sport[])
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.level, p.sports
  from profiles p
  where auth.uid() is not null and cardinality(p_ids) <= 200 and p.id = any (p_ids)
    and (
      p.id = auth.uid()
      or exists (select 1 from bookings b where b.player_id = p.id and is_staff_of(b.club_id))
      or exists (
        select 1 from matches m
        left join match_players mp_me on mp_me.match_id = m.id and mp_me.profile_id = auth.uid()
        left join match_players mp_them on mp_them.match_id = m.id and mp_them.profile_id = p.id
        where (m.organizer_id = auth.uid() or mp_me.profile_id is not null)
          and (m.organizer_id = p.id or mp_them.profile_id is not null)
      )
    );
$$;

-- ---------------------------------------------------------------------------
-- Match chat: organizer + accepted players
-- ---------------------------------------------------------------------------
create table match_messages (
  id          uuid primary key default gen_random_uuid(),
  match_id    uuid not null references matches(id) on delete cascade,
  profile_id  uuid not null references profiles(id),
  body        text not null check (char_length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index match_messages_match_idx on match_messages (match_id, created_at);
alter table match_messages enable row level security;

create or replace function is_match_member(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from matches m where m.id = p_match and m.organizer_id = auth.uid())
      or exists (select 1 from match_players mp where mp.match_id = p_match and mp.profile_id = auth.uid() and mp.status = 'accepted');
$$;
revoke execute on function is_match_member(uuid) from public, anon;
grant execute on function is_match_member(uuid) to authenticated;

create policy "match_messages: members read" on match_messages for select using (is_match_member(match_id));
create policy "match_messages: members write" on match_messages for insert with check (profile_id = auth.uid() and is_match_member(match_id));

-- notify the other members on a new message (one notification per recipient per unread burst would need more; keep simple)
create or replace function match_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; who text;
begin
  select coalesce(name, 'A player') into who from profiles where id = new.profile_id;
  for r in
    select m.organizer_id as pid from matches m where m.id = new.match_id
    union
    select mp.profile_id from match_players mp where mp.match_id = new.match_id and mp.status = 'accepted'
  loop
    if r.pid <> new.profile_id and not exists (
      select 1 from notifications n where n.profile_id = r.pid and n.match_id = new.match_id and n.kind = 'match_message' and n.read_at is null
    ) then
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, who || ': ' || left(new.body, 80));
    end if;
  end loop;
  return new;
end $$;
create trigger match_messages_notify after insert on match_messages for each row execute function match_message_notify();

-- messages with sender names for members
create or replace function match_messages_list(p_match uuid, p_after timestamptz)
returns table (id uuid, profile_id uuid, name text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select x.id, x.profile_id, p.name, x.body, x.created_at
  from match_messages x join profiles p on p.id = x.profile_id
  where x.match_id = p_match and is_match_member(p_match) and (p_after is null or x.created_at > p_after)
  order by x.created_at;
$$;
revoke execute on function match_messages_list(uuid, timestamptz) from public, anon;
grant execute on function match_messages_list(uuid, timestamptz) to authenticated;
