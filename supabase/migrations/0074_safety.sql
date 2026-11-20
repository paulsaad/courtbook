-- 0074 — M3-S chat and player safety (CANDIDATE: number assigned for review; applied nowhere).
-- docs/m3/05-architecture.md §5.6, 02-safety-review.md §2.4, 04-ux-spec.md §4.6.
--
--   player_blocks      block / unblock a player (self-service, instant). Between blocked players, either way:
--                       · join_match and decide_join(accept) refuse ('blocked'); switching a game to Join
--                         straight away leaves a blocked request waiting (it can still be declined)
--                       · neither sees the other's open games on the board
--                     For the blocker only: the blocked player's messages come back flagged with no text,
--                     and no chat notices from them. A game they already share is not changed: both stay;
--                     the organiser may remove, a player may leave.
--   reports            report a message, a player or a game; snapshot kept as evidence; one open report per
--                       reporter and target; readable only through the admin functions
--   moderation         admin_reports, admin_report_messages, admin_resolve_report (actioned / dismissed),
--                       admin_hide_message, admin_suspend / admin_unsuspend — admins only (is_admin())
--   suspension         account_suspensions (not readable through the API): every game write and chat message refused ('account_suspended');
--                       reading, leaving, deleting own messages, blocking and reporting still work; bookings
--                       (M2) unaffected
--   rules_accepted_at  community rules accepted once before the first message ('rules_not_accepted')
--   blocked_terms      word list, EMPTY here (filled only with approval) → 'message_not_allowed'
--   help & feedback    send_feedback (app problem / suggestion, kept in reports, admins only, 10 a day);
--                       my_recent_players (whom I can report from Profile, never more than games show me)
--
-- Not here: report email to the moderator (M3-D `deliver`), snapshot retention job (P3).
-- Replaces: 0073 post_match; 0072 join_match, decide_join, update_match, set_match_status, remove_player,
-- resolve_court, match_message_guard, match_message_notify; 0042 match_messages_list (+ blocked);
-- 0041 open_matches and 0045 match_board (+ the block filter). Each replaced game function is its current
-- definition with one added line (suspension), plus the two block rules above in decide_join/update_match.
-- Rollback (supabase/live/0074_rollback.sql) restores every function and keeps the new tables' data.

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
-- suspension lives in its own table: nothing of it is readable through the API (moderator functions only)
create table if not exists account_suspensions (
  profile_id   uuid primary key references profiles(id) on delete cascade,
  suspended_at timestamptz not null default now(),
  reason       text not null,
  suspended_by uuid references profiles(id)
);
alter table account_suspensions enable row level security;
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

-- 0072's chat guard, plus: not suspended, rules accepted, no blocked term
create or replace function match_message_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();        -- S2: the server's clock, never the sender's
  new.deleted_at := null;         -- S9: a message cannot arrive deleted (and so skip the length check)
  if (select status from matches where id = new.match_id) = 'cancelled' then raise exception 'match_cancelled'; end if;
  if exists (select 1 from account_suspensions where profile_id = new.profile_id) then raise exception 'account_suspended'; end if;
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

-- the table itself: a blocker cannot read the blocked player's messages directly either
drop policy if exists "match_messages: members read" on match_messages;
create policy "match_messages: members read" on match_messages for select using (
  is_match_member(match_id)
  and not exists (select 1 from player_blocks b where b.blocker_id = auth.uid() and b.blocked_id = match_messages.profile_id));

-- ---------------------------------------------------------------------------------------------
-- Reports
create table if not exists reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  target_kind text not null check (target_kind in ('message', 'player', 'game', 'feedback')),  -- feedback: Help & Feedback
  message_id  uuid references match_messages(id) on delete set null,
  profile_id  uuid references profiles(id) on delete set null,
  match_id    uuid references matches(id) on delete set null,
  target_key  uuid not null,                         -- the reported thing's id, kept if it is deleted (feedback: its own)
  reason      text not null check (reason in ('spam', 'abuse', 'inappropriate', 'danger', 'other', 'app_problem', 'suggestion')),
  note        text check (char_length(note) <= 1000),  -- reports 500 (report_content), feedback 1000
  snapshot    text,                                  -- the message text or name at report time (evidence); feedback: app version
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

-- Help & Feedback (Profile): an app problem or a suggestion, private to CourtBook's admins. Kept in
-- reports so the moderator has one list (admin_reports) and one way to close it (admin_resolve_report).
-- A suspended player can still write (it is how they reach us). At most 10 a day per player.
create or replace function send_feedback(p_kind text, p_text text, p_context text default null) returns void
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); body text := trim(coalesce(p_text, ''));
begin
  if me is null then raise exception 'not_authenticated'; end if;
  if p_kind is null or p_kind not in ('app_problem', 'suggestion') then raise exception 'bad_reason'; end if;
  if body = '' then raise exception 'text_required'; end if;
  if char_length(body) > 1000 then raise exception 'note_too_long'; end if;
  perform pg_advisory_xact_lock(hashtext('send_feedback'), hashtext(me::text));
  if (select count(*) from reports where reporter_id = me and target_kind = 'feedback'
        and created_at > now() - interval '1 day') >= 10 then
    raise exception 'slow_down';
  end if;
  insert into reports (reporter_id, target_kind, target_key, reason, note, snapshot)
  values (me, 'feedback', gen_random_uuid(), p_kind, body, left(nullif(trim(coalesce(p_context, '')), ''), 200));
end $$;
revoke all on function send_feedback(text, text, text) from public, anon;
grant execute on function send_feedback(text, text, text) to authenticated;

-- Help & Feedback → "Report player behaviour": the players I can pick, from games in the last 60 days
-- and upcoming ones, never more than the game screens already show me (organiser: everyone in or
-- asking; accepted player: the organiser and the other accepted players; waiting: the organiser).
-- The report itself is report_content('player', …), unchanged.
create or replace function my_recent_players()
returns table (profile_id uuid, name text, last_game timestamptz)
language sql stable security definer set search_path = public as $$
  with mine as (
    select m.id, m.start_at, m.organizer_id, (m.organizer_id = auth.uid()) as organiser, mp.status::text as my_status
    from matches m left join match_players mp on mp.match_id = m.id and mp.profile_id = auth.uid()
    where auth.uid() is not null and m.start_at > now() - interval '60 days'
      and (m.organizer_id = auth.uid() or mp.status::text in ('accepted', 'pending'))
  ), seen as (
    select organizer_id as pid, start_at from mine
    union all
    select p.profile_id, mine.start_at from mine join match_players p on p.match_id = mine.id
    where (mine.organiser and p.status::text in ('accepted', 'pending'))
       or (mine.my_status = 'accepted' and p.status::text = 'accepted')
  )
  select s.pid, pr.name, max(s.start_at) from seen s join profiles pr on pr.id = s.pid
  where s.pid <> auth.uid()
  group by s.pid, pr.name
  order by max(s.start_at) desc
  limit 50;
$$;
revoke all on function my_recent_players() from public, anon;
grant execute on function my_recent_players() to authenticated;

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

-- ---------------------------------------------------------------------------------------------
-- Suspension and the moderator's tools (admins only: is_admin(); everyone else 'forbidden').
-- A suspended account cannot post, join, ask, decide, edit, change status, remove, resolve a court or
-- send a message ('account_suspended'). It can still read, leave a game, delete its own messages, block
-- and report. Bookings (M2) are not affected.
create or replace function assert_active() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from account_suspensions where profile_id = auth.uid()) then raise exception 'account_suspended'; end if;
end $$;
revoke all on function assert_active() from public, anon, authenticated;

-- the moderator's list: each report with what was reported (the snapshot is the evidence)
create or replace function admin_reports(p_status text default 'open')
returns table (id uuid, created_at timestamptz, target_kind text, reason text, note text, snapshot text, status text,
               reporter_id uuid, reporter_name text, profile_id uuid, reported_name text, reported_suspended boolean,
               reports_against int, match_id uuid, message_id uuid, message_deleted boolean, handled_at timestamptz, action text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select r.id, r.created_at, r.target_kind, r.reason, r.note, r.snapshot, r.status,
         r.reporter_id, rp.name, r.profile_id, tp.name, exists (select 1 from account_suspensions s where s.profile_id = r.profile_id),
         (select count(*)::int from reports x where x.profile_id = r.profile_id),
         r.match_id, r.message_id, mm.deleted_at is not null, r.handled_at, r.action
  from reports r
  left join profiles rp on rp.id = r.reporter_id
  left join profiles tp on tp.id = r.profile_id
  left join match_messages mm on mm.id = r.message_id
  where p_status is null or r.status = p_status
  order by r.created_at desc
  limit 200;
end $$;

-- the conversation around a reported message (or the game's last messages): context for the decision
create or replace function admin_report_messages(p_report uuid)
returns table (id uuid, created_at timestamptz, sender text, body text, deleted boolean, reported boolean)
language plpgsql stable security definer set search_path = public as $$
declare r reports%rowtype; at timestamptz;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into r from reports where reports.id = p_report;
  if not found or r.match_id is null then return; end if;
  select x.created_at into at from match_messages x where x.id = r.message_id;
  return query
  select x.id, x.created_at, p.name, x.body, x.deleted_at is not null, x.id = r.message_id
  from match_messages x join profiles p on p.id = x.profile_id
  where x.match_id = r.match_id
    and (at is null or x.created_at between at - interval '30 minutes' and at + interval '30 minutes')
  order by x.created_at desc
  limit 40;
end $$;

-- close a report: actioned (something was done) or dismissed (nothing breaks the rules)
create or replace function admin_resolve_report(p_report uuid, p_status text, p_action text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_status not in ('actioned', 'dismissed') then raise exception 'bad_status'; end if;
  update reports set status = p_status, action = nullif(trim(coalesce(p_action, '')), ''), handled_by = auth.uid(),
         handled_at = now(), closed_at = now()
   where id = p_report;
  if not found then raise exception 'not_found'; end if;
end $$;

-- hide a message for everyone (soft delete, as the sender's own delete; the report keeps its snapshot)
create or replace function admin_hide_message(p_message uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update match_messages set body = '', deleted_at = now() where id = p_message and deleted_at is null;
end $$;

create or replace function admin_suspend(p_profile uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_profile = auth.uid() then raise exception 'bad_target'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'not_found'; end if;
  insert into account_suspensions (profile_id, reason, suspended_by) values (p_profile, trim(p_reason), auth.uid())
  on conflict (profile_id) do update set reason = excluded.reason, suspended_by = excluded.suspended_by;
end $$;

create or replace function admin_unsuspend(p_profile uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  delete from account_suspensions where profile_id = p_profile;
end $$;

-- a player sees whether their own account is suspended (the app explains instead of failing silently)
create or replace function my_account_status() returns text
language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from account_suspensions where profile_id = auth.uid()) then 'suspended' else 'active' end;
$$;

revoke all on function admin_reports(text), admin_report_messages(uuid), admin_resolve_report(uuid, text, text),
  admin_hide_message(uuid), admin_suspend(uuid, text), admin_unsuspend(uuid), my_account_status() from public, anon;
grant execute on function admin_reports(text), admin_report_messages(uuid), admin_resolve_report(uuid, text, text),
  admin_hide_message(uuid), admin_suspend(uuid, text), admin_unsuspend(uuid), my_account_status() to authenticated;

-- nothing about reports, terms or blocks is readable or writable directly through the API: only
-- through the functions above (row-level security is on with no policy besides "player_blocks: own")
revoke all on table reports, blocked_terms, account_suspensions from anon, authenticated;
revoke insert, update, delete on table player_blocks from anon, authenticated;
revoke all on table player_blocks from anon;

-- ---------------------------------------------------------------------------------------------
-- Game functions: current definitions + assert_active(); decide_join and update_match: block rules.
CREATE OR REPLACE FUNCTION public.post_match(p_club uuid, p_sport sport, p_start timestamp with time zone, p_end timestamp with time zone, p_level_min integer, p_level_max integer, p_players_needed integer, p_note text, p_booking uuid, p_join_mode text DEFAULT 'open'::text, p_token uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare
  v_id uuid := gen_random_uuid();
  b bookings%rowtype;
  v_court_sport sport;
  v_existing uuid;
  v_constraint text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  -- a repeat of a post that already succeeded: the same game, nothing new (checked before any rule,
  -- so a retry is not refused by a limit the first call itself reached)
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = auth.uid() for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> p_sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    p_club := b.club_id; p_start := b.start_at; p_end := b.end_at;
  else
    if p_club is null then raise exception 'club_required'; end if;
    if p_start is not null and p_start >= now() + interval '60 days' then raise exception 'too_far_ahead'; end if;
  end if;
  if p_start is null or p_start <= now() then raise exception 'slot_in_past'; end if;
  if p_end is not null and p_end <= p_start then raise exception 'bad_range'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  -- S12: live games = not cancelled and not started; one count at a time per organiser, so two
  -- simultaneous posts cannot both see 9 (and two retries with one key wait for each other here)
  perform pg_advisory_xact_lock(hashtextextended('courtbook:post_match:' || auth.uid()::text, 0));
  if p_token is not null then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  if (select count(*) from matches where organizer_id = auth.uid() and status <> 'cancelled' and start_at > now()) >= 10 then
    raise exception 'too_many_games';
  end if;
  insert into matches (id, club_id, sport, organizer_id, start_at, end_at, level_min, level_max, players_needed, note, booking_id, join_mode, client_token)
  values (v_id, p_club, p_sport, auth.uid(), p_start, p_end, p_level_min, p_level_max, p_players_needed, nullif(trim(p_note), ''), p_booking, p_join_mode, p_token);
  return v_id;
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'matches_organizer_client_token' then
    select id into v_existing from matches where organizer_id = auth.uid() and client_token = p_token;
    if v_existing is not null then return v_existing; end if;
  end if;
  raise exception 'booking_already_posted';
end $fn$;

CREATE OR REPLACE FUNCTION public.join_match(p_match uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; n int; me text; cur text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if m.organizer_id = auth.uid() then raise exception 'organizer_cannot_join'; end if;

  select status into cur from match_players where match_id = p_match and profile_id = auth.uid();
  if cur in ('accepted', 'pending') then return cur; end if;       -- idempotent
  if cur = 'declined' then raise exception 'join_declined'; end if; -- final (GR-5, GR-6)

  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if n >= m.players_needed then raise exception 'match_full'; end if;
  select coalesce(name, 'A player') into me from profiles where id = auth.uid();

  if m.join_mode = 'approval' then
    -- one count at a time per player: two requests to two different games cannot both see 19 (S12)
    perform pg_advisory_xact_lock(hashtextextended('courtbook:requests:' || auth.uid()::text, 0));
    if (select count(*) from match_players mp join matches x on x.id = mp.match_id
        where mp.profile_id = auth.uid() and mp.status = 'pending'
          and x.status <> 'cancelled' and x.start_at > now()) >= 20 then
      raise exception 'too_many_requests';
    end if;
    insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'pending');
    perform notify(m.organizer_id, 'join_request', p_match, me || ' wants to join your match');
    return 'pending';
  end if;

  insert into match_players (match_id, profile_id, status) values (p_match, auth.uid(), 'accepted');
  perform notify(m.organizer_id, 'player_joined', p_match, me || ' joined your match');
  if n + 1 >= m.players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
    perform notify_waiting(p_match);
  end if;
  return 'accepted';
end $fn$;

CREATE OR REPLACE FUNCTION public.decide_join(p_match uuid, p_profile uuid, p_accept boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'pending') then
    raise exception 'not_pending';
  end if;
  if p_accept then
    if m.status <> 'open' or m.start_at <= now() then raise exception 'match_closed'; end if;
    -- M3-S: a request between blocked players is never accepted (it can still be declined)
    if players_blocked(p_profile, m.organizer_id) then raise exception 'blocked'; end if;
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
    update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = p_profile;
    perform notify(p_profile, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
    if n + 1 >= m.players_needed then
      update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
      perform notify_waiting(p_match);
    end if;
  else
    -- declining a stale request is allowed (cleans up), no notification if the match is gone
    update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
    if m.status = 'open' then perform notify(p_profile, 'join_declined', p_match, 'The organizer could not take you for this match'); end if;
  end if;
end $fn$;

CREATE OR REPLACE FUNCTION public.update_match(p_match uuid, p_players_needed integer, p_level_min integer, p_level_max integer, p_note text, p_join_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; n int; st match_status; r record;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if p_players_needed is null or p_players_needed < 1 or p_players_needed > 30 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  if (p_level_min is null) <> (p_level_max is null) or (p_level_min is not null and (p_level_min < 1 or p_level_max > 10 or p_level_min > p_level_max)) then raise exception 'bad_level_range'; end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if p_players_needed < n then raise exception 'below_accepted'; end if;
  update matches set players_needed = p_players_needed, level_min = p_level_min, level_max = p_level_max, level = null,
    note = nullif(trim(p_note), ''), join_mode = p_join_mode where id = p_match;
  -- a private or no_court game stays as it is: only a game closed because it filled up reopens
  st := m.status;
  if m.status = 'open' and n >= p_players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
    perform notify_waiting(p_match);
    st := 'closed';
  elsif m.status = 'closed' and m.closed_reason = 'full' and n < p_players_needed then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
    st := 'open';
  end if;
  -- S15: approval → open while the game takes players: waiting requests are accepted in the order
  -- they were made, up to capacity; the rest keep waiting (and are told once if it fills)
  if m.join_mode = 'approval' and p_join_mode = 'open' and st = 'open' then
    for r in select profile_id from match_players where match_id = p_match and status = 'pending'
             and not players_blocked(profile_id, m.organizer_id)   -- M3-S: blocked requests keep waiting
             order by joined_at, profile_id loop
      exit when n >= p_players_needed;
      update match_players set status = 'accepted', decided_at = now() where match_id = p_match and profile_id = r.profile_id;
      perform notify(r.profile_id, 'join_accepted', p_match, 'You are in: ' || coalesce((select name from profiles where id = m.organizer_id), 'the organizer') || ' accepted you');
      n := n + 1;
    end loop;
    if n >= p_players_needed then
      update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
      perform notify_waiting(p_match);
    end if;
  end if;
end $fn$;

CREATE OR REPLACE FUNCTION public.set_match_status(p_match uuid, p_status match_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; r record; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' and p_status <> 'cancelled' then raise exception 'cannot_reopen'; end if;
  if m.status = 'cancelled' then return; end if;                       -- cancelling twice: nothing to do
  if p_status = 'cancelled' then
    if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then raise exception 'match_over'; end if;
  else
    if m.start_at <= now() then raise exception 'match_started'; end if;
    if m.court_lost_at is not null then raise exception 'court_lost'; end if;  -- one way out: resolve_court
  end if;
  if p_status = 'open' and m.status <> 'open' then
    select count(*) into n from match_players where match_id = p_match and status = 'accepted';
    if n >= m.players_needed then raise exception 'match_full'; end if;
  end if;
  update matches set status = p_status,
    closed_at = case when p_status = 'open' then null else now() end,
    closed_reason = case when p_status = 'closed' then 'organizer' else null end
  where id = p_match;
  if p_status = 'closed' then
    for r in select profile_id from match_players where match_id = p_match and status = 'pending' loop
      delete from match_players where match_id = p_match and profile_id = r.profile_id and status = 'pending';
      perform notify(r.profile_id, 'join_declined', p_match, 'The organizer made this match private');
    end loop;
  end if;
  if p_status = 'cancelled' then
    for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
      perform notify(r.profile_id, 'match_cancelled', p_match, 'Match cancelled by the organizer');
    end loop;
  end if;
end $fn$;

CREATE OR REPLACE FUNCTION public.remove_player(p_match uuid, p_profile uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' then raise exception 'match_cancelled'; end if;
  if m.start_at <= now() then raise exception 'match_started'; end if;
  if not exists (select 1 from match_players where match_id = p_match and profile_id = p_profile and status = 'accepted') then
    raise exception 'not_accepted';                                    -- a request is declined, not removed
  end if;
  update match_players set status = 'declined', decided_at = now() where match_id = p_match and profile_id = p_profile;
  perform notify(p_profile, 'player_removed', p_match, 'The organizer removed you from this match');
  if m.status = 'closed' and m.closed_reason = 'full' then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
  end if;
end $fn$;

CREATE OR REPLACE FUNCTION public.resolve_court(p_match uuid, p_booking uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
declare m matches%rowtype; b bookings%rowtype; v_court_sport sport; n int; r record; msg text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  perform assert_active();             -- M3-S: a suspended account makes no game changes
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() and not is_admin() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' then raise exception 'match_cancelled'; end if;
  if m.court_lost_at is null then raise exception 'court_not_lost'; end if;
  if coalesce(m.end_at, m.start_at + interval '3 hours') <= now() then raise exception 'match_over'; end if;
  if p_booking is not null then
    select * into b from bookings where id = p_booking and player_id = m.organizer_id for update;
    if not found or b.status <> 'confirmed' then raise exception 'booking_not_found'; end if;
    if b.start_at <= now() then raise exception 'slot_in_past'; end if;
    select sport into v_court_sport from courts where id = b.court_id;
    if v_court_sport is not null and v_court_sport <> m.sport then raise exception 'sport_mismatch'; end if;
    if exists (select 1 from matches where booking_id = p_booking and status <> 'cancelled') then raise exception 'booking_already_posted'; end if;
    update matches set booking_id = b.id, club_id = b.club_id, start_at = b.start_at, end_at = b.end_at where id = p_match;
    msg := 'The organizer linked a new court booking to your match — check the time and court';
  else
    msg := 'Your match goes ahead. No court is booked through CourtBook — the organizer is arranging it';
  end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  update matches set court_lost_at = null,
    status = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then 'closed' else 'open' end)::match_status else m.status end,
    closed_reason = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then 'full' end) else m.closed_reason end,
    closed_at = case when m.closed_reason = 'no_court' then (case when n >= m.players_needed then now() end) else m.closed_at end
  where id = p_match;
  for r in select profile_id from match_players where match_id = p_match and status in ('accepted', 'pending') loop
    perform notify(r.profile_id, 'court_resolved', p_match, msg);
  end loop;
exception when unique_violation then
  raise exception 'booking_already_posted';
end $fn$;

notify pgrst, 'reload schema';
