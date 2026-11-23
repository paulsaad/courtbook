-- 0080 — 18+ at launch (decided 23 Nov 2026; master launch checklist L3).
--
-- A player confirms once that they are at least 18. Recorded: when, and through which channel (web or app). No birth
-- date, no document, nothing else. Saying "I am under 18" records nothing and grants nothing.
--
-- Enforced in the database, for every request made by a signed-in user (any client, any direct API call): no new
-- booking, game, join, chat message or coach listing for a person who has not confirmed. Club staff and admin work
-- (desk bookings for guests, blocks, settings, moderation) creates no player rows in the staff member's name and is
-- unaffected; a staff member's or admin's own player activity is gated like anyone's. Server work (auth.uid() null:
-- seeds, sweepers, the SQL editor) is unaffected.
--
-- Switch: app_settings 'require_age_confirmation' = 'true' turns enforcement on. Absent = off, so the live apps that
-- predate the confirmation screen keep working until the new versions are out; the website and the new apps ask for
-- the confirmation whatever the switch says. Turning it on is a rollout step of its own.

alter table profiles add column if not exists age_confirmed_at timestamptz;
alter table profiles add column if not exists age_confirmed_via text;
do $$ begin
  alter table profiles add constraint profiles_age_confirmed_via_check check (age_confirmed_via in ('web', 'app'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table profiles add constraint profiles_age_confirmed_pair check ((age_confirmed_at is null) = (age_confirmed_via is null));
exception when duplicate_object then null; end $$;

-- the two columns are written only by confirm_age (a signed-in user cannot set or clear them through "update own
-- profile"; an admin cannot confirm for someone else). Server context (SQL editor, migrations) is trusted.
create or replace function protect_age_confirmation() returns trigger
language plpgsql as $$
begin
  if (new.age_confirmed_at is distinct from old.age_confirmed_at or new.age_confirmed_via is distinct from old.age_confirmed_via)
     and auth.uid() is not null and coalesce(current_setting('courtbook.confirming_age', true), '') <> 'on' then
    raise exception 'age_confirmation_by_function_only';
  end if;
  return new;
end $$;
revoke all on function protect_age_confirmation() from public, anon, authenticated;
drop trigger if exists profiles_protect_age on profiles;
create trigger profiles_protect_age before update on profiles for each row execute function protect_age_confirmation();

create or replace function age_confirmation_required() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_settings where key = 'require_age_confirmation'), 'false') = 'true';
$$;
revoke all on function age_confirmation_required() from public, anon, authenticated;
grant execute on function age_confirmation_required() to service_role;

-- the person's side
create or replace function confirm_age(p_is_18_or_over boolean, p_via text default 'web') returns jsonb
language plpgsql security definer set search_path = public as $$
declare r profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_via is null or p_via not in ('web', 'app') then raise exception 'invalid_via'; end if;
  if p_is_18_or_over is distinct from true then raise exception 'under_18'; end if;   -- nothing recorded
  perform set_config('courtbook.confirming_age', 'on', true);
  update profiles set age_confirmed_at = coalesce(age_confirmed_at, now()),
                      age_confirmed_via = coalesce(age_confirmed_via, p_via)
   where id = auth.uid() returning * into r;
  perform set_config('courtbook.confirming_age', '', true);
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('confirmed', true, 'confirmed_at', r.age_confirmed_at);
end $$;

-- what the website and the apps ask before player activity: confirmed, and whether the server enforces it yet
create or replace function my_age_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'confirmed', coalesce((select age_confirmed_at is not null from profiles where id = auth.uid()), false),
    'required', age_confirmation_required()) end;
$$;

revoke all on function confirm_age(boolean, text) from public, anon, authenticated;
revoke all on function my_age_status() from public, anon, authenticated;
grant execute on function confirm_age(boolean, text) to authenticated, service_role;
grant execute on function my_age_status() to authenticated, service_role;

-- enforcement: the person named on a new player row must have confirmed, whenever a signed-in user makes the request
create or replace function require_age_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_who uuid;
begin
  if auth.uid() is null or not age_confirmation_required() then return new; end if;
  v_who := (to_jsonb(new) ->> tg_argv[0])::uuid;                  -- the column naming the person (trigger argument)
  if v_who is not null and not exists (select 1 from profiles where id = v_who and age_confirmed_at is not null) then
    raise exception 'age_not_confirmed';
  end if;
  return new;
end $$;
revoke all on function require_age_confirmed() from public, anon, authenticated;

drop trigger if exists bookings_age_check on bookings;
create trigger bookings_age_check before insert on bookings for each row execute function require_age_confirmed('player_id');
drop trigger if exists matches_age_check on matches;
create trigger matches_age_check before insert on matches for each row execute function require_age_confirmed('organizer_id');
drop trigger if exists match_players_age_check on match_players;
create trigger match_players_age_check before insert on match_players for each row execute function require_age_confirmed('profile_id');
drop trigger if exists match_messages_age_check on match_messages;
create trigger match_messages_age_check before insert on match_messages for each row execute function require_age_confirmed('profile_id');
drop trigger if exists coaches_age_check on coaches;
create trigger coaches_age_check before insert on coaches for each row execute function require_age_confirmed('profile_id');
