-- M3-S — chat and player safety (docs/m3/05-architecture.md §5.6, 02-safety-review.md §2.4, 04-ux-spec.md §4.6).
-- DRAFT FOR REVIEW. Number assigned at approval. Applied nowhere.
--
--   player_blocks      block / unblock a player (self-service, instant)
--                       · join_match refused ('blocked') between them, either way
--                       · neither sees the other's open games on the board (games already shared stay)
--                       · the blocker sees "Message from a player you blocked" (body withheld)
--                       · no chat notices to a player who blocked the sender
--   reports            report a message, a player or a game; snapshot kept as evidence; admin-only read;
--                       one open report per reporter and target (a repeat is a no-op)
--   rules_accepted_at  community rules, accepted once before the first message ('rules_not_accepted')
--   blocked_terms      short word list (filled by the operator; empty here) → 'message_not_allowed'
--
-- Not in this draft (separate review): account suspension (suspended_at on every write), admin RPCs
-- and the web "Reports" page (P2), the report email to the moderator (M3-D `deliver`), the term list
-- itself, retention job for report snapshots (P3).
-- Builds on 0072 (chat guard, notices); replaces 0072's match_message_guard and match_message_notify,
-- 0045's match_board and 0041's open_matches with the block filter added and nothing else changed.

-- ---------------------------------------------------------------------------------------------
-- Blocks
create table if not exists player_blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists player_blocks_blocked_idx on player_blocks (blocked_id);
alter table player_blocks enable row level security;
drop policy if exists "player_blocks: own" on player_blocks;
create policy "player_blocks: own" on player_blocks for select to authenticated using (blocker_id = auth.uid());

-- either way: a block by one side separates both
create or replace function players_blocked(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null and exists (
    select 1 from player_blocks where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a));
$$;
revoke all on function players_blocked(uuid, uuid) from public, anon, authenticated;

create or replace function block_player(p_profile uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_profile is null or p_profile = auth.uid() then raise exception 'bad_target'; end if;
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'not_found'; end if;
  insert into player_blocks (blocker_id, blocked_id) values (auth.uid(), p_profile) on conflict do nothing;
end $$;
create or replace function unblock_player(p_profile uuid) returns void
language sql security definer set search_path = public as $$
  delete from player_blocks where blocker_id = auth.uid() and blocked_id = p_profile;
$$;
create or replace function my_blocked_players()
returns table (profile_id uuid, name text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.blocked_id, p.name, b.created_at from player_blocks b join profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid() order by b.created_at desc;
$$;
revoke all on function block_player(uuid), unblock_player(uuid), my_blocked_players() from public, anon;
grant execute on function block_player(uuid), unblock_player(uuid), my_blocked_players() to authenticated;

-- join_match (and anything else that adds a player) is refused between blocked players
create or replace function match_players_block_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if players_blocked(new.profile_id, (select organizer_id from matches where id = new.match_id)) then
    raise exception 'blocked';
  end if;
  return new;
end $$;
drop trigger if exists match_players_block_guard on match_players;
create trigger match_players_block_guard before insert on match_players
  for each row execute function match_players_block_guard();

-- ---------------------------------------------------------------------------------------------
-- Community rules (once) and the word filter
alter table profiles add column if not exists rules_accepted_at timestamptz;
create or replace function accept_community_rules() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  update profiles set rules_accepted_at = coalesce(rules_accepted_at, now()) where id = auth.uid() returning rules_accepted_at into t;
  return t;
end $$;
create or replace function my_rules_accepted() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select rules_accepted_at is not null from profiles where id = auth.uid()), false);
$$;
revoke all on function accept_community_rules(), my_rules_accepted() from public, anon;
grant execute on function accept_community_rules(), my_rules_accepted() to authenticated;

create table if not exists blocked_terms (
  term text primary key check (term = lower(term) and char_length(term) between 2 and 60),
  lang text
);
alter table blocked_terms enable row level security;   -- no policy: not readable through the API

-- a term matches as a whole word (or phrase), case-insensitively; Arabic and Latin letters alike
create or replace function message_has_blocked_term(p_body text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from blocked_terms t
    where lower(p_body) ~ ('(^|[^[:alnum:]])' || regexp_replace(t.term, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '($|[^[:alnum:]])'));
$$;
revoke all on function message_has_blocked_term(text) from public, anon, authenticated;

-- 0072's chat guard, plus: rules accepted, no blocked term
create or replace function match_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();        -- S2: the server's clock, never the sender's
  new.deleted_at := null;         -- S9: a message cannot arrive deleted (and so skip the length check)
  if (select status from matches where id = new.match_id) = 'cancelled' then raise exception 'match_cancelled'; end if;
  if not exists (select 1 from profiles where id = new.profile_id and rules_accepted_at is not null) then
    raise exception 'rules_not_accepted';
  end if;
  if message_has_blocked_term(new.body) then raise exception 'message_not_allowed'; end if;
  -- one count at a time per sender and game: parallel inserts cannot all see 29 (S12)
  perform pg_advisory_xact_lock(hashtextextended('courtbook:chat:' || new.match_id::text || ':' || new.profile_id::text, 0));
  if (select count(*) from match_messages where match_id = new.match_id and profile_id = new.profile_id
      and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'slow_down';
  end if;
  return new;
end $$;

-- 0072's chat notices, plus: none to a member who blocked the sender
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
    if r.pid <> new.profile_id
       and not exists (select 1 from match_hidden h where h.profile_id = r.pid and h.match_id = new.match_id)
       and not exists (select 1 from player_blocks pb where pb.blocker_id = r.pid and pb.blocked_id = new.profile_id)
       and not exists (
         select 1 from notifications n where n.profile_id = r.pid and n.match_id = new.match_id and n.kind = 'match_message' and n.read_at is null
       ) then
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, who || ': ' || left(new.body, 80));
    end if;
  end loop;
  return new;
end $$;

-- the chat list flags (and withholds) messages from a player the reader blocked
drop function if exists match_messages_list(uuid, timestamptz);
create function match_messages_list(p_match uuid, p_after timestamptz)
returns table (id uuid, profile_id uuid, name text, body text, created_at timestamptz, deleted boolean, blocked boolean)
language sql stable security definer set search_path = public as $$
  select x.id, x.profile_id, p.name,
         case when x.deleted_at is not null or bl.blocked_id is not null then '' else x.body end,
         x.created_at, x.deleted_at is not null, bl.blocked_id is not null
  from match_messages x join profiles p on p.id = x.profile_id
  left join player_blocks bl on bl.blocker_id = auth.uid() and bl.blocked_id = x.profile_id
  where x.match_id = p_match and is_match_member(p_match) and (p_after is null or x.created_at > p_after)
    and not exists (select 1 from match_hidden h where h.match_id = p_match and h.profile_id = auth.uid())
  order by x.created_at;
$$;
revoke execute on function match_messages_list(uuid, timestamptz) from public, anon;
grant execute on function match_messages_list(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reports
create table if not exists reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  target_kind text not null check (target_kind in ('message', 'player', 'game')),
  message_id  uuid references match_messages(id) on delete set null,
  profile_id  uuid references profiles(id) on delete set null,
  match_id    uuid references matches(id) on delete set null,
  target_key  uuid not null,                         -- the reported thing's id, kept if it is deleted
  reason      text not null check (reason in ('spam', 'abuse', 'inappropriate', 'danger', 'other')),
  note        text check (char_length(note) <= 500),
  snapshot    text,                                  -- the message text or name at report time (evidence)
  created_at  timestamptz not null default now(),
  status      text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  handled_by  uuid references profiles(id),
  handled_at  timestamptz,
  action      text,
  emailed_at  timestamptz,
  legal_hold  boolean not null default false,
  closed_at   timestamptz
);
create unique index if not exists reports_one_open on reports (reporter_id, target_kind, target_key) where status = 'open';
alter table reports enable row level security;   -- no policy: nobody reads reports through the API (admin RPCs, later)

create or replace function report_content(p_kind text, p_target uuid, p_reason text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); msg match_messages%rowtype; who uuid; game uuid; snap text;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if p_reason not in ('spam', 'abuse', 'inappropriate', 'danger', 'other') then raise exception 'bad_reason'; end if;
  if char_length(coalesce(p_note, '')) > 500 then raise exception 'note_too_long'; end if;
  if p_kind = 'message' then
    select * into msg from match_messages where id = p_target;
    -- the reporter must be able to read it: a member of that game's chat
    if not found or not exists (select 1 from matches m where m.id = msg.match_id and m.organizer_id = me)
       and not exists (select 1 from match_players mp where mp.match_id = msg.match_id and mp.profile_id = me and mp.status = 'accepted') then
      raise exception 'not_found';
    end if;
    if msg.profile_id = me then raise exception 'bad_target'; end if;
    who := msg.profile_id; game := msg.match_id; snap := msg.body;
  elsif p_kind = 'player' then
    if p_target = me then raise exception 'bad_target'; end if;
    -- only someone the reporter has met through a game (organiser, player or request, either side)
    select m.id into game from matches m
      where (m.organizer_id = me or exists (select 1 from match_players a where a.match_id = m.id and a.profile_id = me))
        and (m.organizer_id = p_target or exists (select 1 from match_players b where b.match_id = m.id and b.profile_id = p_target))
      order by m.start_at desc limit 1;
    if game is null then raise exception 'not_found'; end if;
    who := p_target; snap := (select name from profiles where id = p_target);
  elsif p_kind = 'game' then
    select m.id, m.organizer_id, coalesce(m.note, '') into game, who, snap from matches m
      where m.id = p_target and (m.status = 'open' or m.organizer_id = me
        or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = me));
    if game is null then raise exception 'not_found'; end if;
    if who = me then raise exception 'bad_target'; end if;
  else
    raise exception 'bad_target';
  end if;
  insert into reports (reporter_id, target_kind, message_id, profile_id, match_id, target_key, reason, note, snapshot)
  values (me, p_kind, case when p_kind = 'message' then p_target end, who, game, p_target, p_reason, nullif(trim(p_note), ''), snap)
  on conflict (reporter_id, target_kind, target_key) where status = 'open' do nothing;
end $$;
revoke all on function report_content(text, uuid, text, text) from public, anon;
grant execute on function report_content(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Board: games of a blocked player (either way) leave the board. Exact current definitions (0041
-- open_matches, 0045 match_board) with one condition added each; games already shared stay visible.
CREATE OR REPLACE FUNCTION public.match_board(p_club uuid, p_days integer)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, pending integer, status match_status, closed_reason text, note text, join_mode text, organizer_id uuid, organizer_name text, my_status text, i_organize boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select m.id, m.club_id, c.name, c.slug, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         (select pl.level from player_levels pl where pl.profile_id = auth.uid() and pl.sport = m.sport),
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'pending')::int,
         m.status, m.closed_reason, m.note, m.join_mode, m.organizer_id, o.name,
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
    and ((m.status = 'open' and not players_blocked(auth.uid(), m.organizer_id)) or m.organizer_id = auth.uid()
         or exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid()
                      and mp.status in ('accepted', 'pending')))
  order by m.start_at;
$fn$;

CREATE OR REPLACE FUNCTION public.open_matches(p_sport sport DEFAULT NULL::sport, p_fit text DEFAULT NULL::text, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_governorate text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS TABLE(match_id uuid, club_id uuid, club_name text, club_slug text, town text, sport sport, start_at timestamp with time zone, end_at timestamp with time zone, level_min integer, level_max integer, level_legacy boolean, my_level integer, players_needed integer, joined integer, note text, organizer_name text, join_mode text, i_joined boolean, booking_id uuid, court_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select m.id, m.club_id, c.name, c.slug, t.name_en, m.sport, m.start_at, m.end_at,
         (match_level_bounds(m))[1], (match_level_bounds(m))[2], m.level_min is null and m.level is not null,
         pl.level,
         m.players_needed,
         (select count(*) from match_players mp where mp.match_id = m.id and mp.status = 'accepted')::int,
         m.note, o.name, m.join_mode,
         exists (select 1 from match_players mp where mp.match_id = m.id and mp.profile_id = auth.uid() and mp.status in ('accepted', 'pending')),
         m.booking_id, k.name
  from matches m
  join clubs c on c.id = m.club_id
  left join towns t on t.id = c.town_id
  left join districts d on d.code = t.district_code
  left join profiles o on o.id = m.organizer_id
  left join bookings b on b.id = m.booking_id
  left join courts k on k.id = b.court_id
  left join player_levels pl on pl.profile_id = auth.uid() and pl.sport = m.sport
  where auth.uid() is not null and m.status = 'open' and m.organizer_id <> auth.uid()
    and not players_blocked(auth.uid(), m.organizer_id)
    and m.start_at > coalesce(p_from, now()) and m.start_at < coalesce(p_to, now() + interval '14 days')
    and (p_sport is null or m.sport = p_sport)
    and (p_fit is distinct from 'mine' or pl.level is null or match_level_bounds(m) is null
         or (pl.level between (match_level_bounds(m))[1] and (match_level_bounds(m))[2]))
    and (p_governorate is null or d.governorate_code = p_governorate)
    and (p_district is null or d.code = p_district)
  order by m.start_at
  limit least(coalesce(p_limit, 50), 100);
$fn$;
