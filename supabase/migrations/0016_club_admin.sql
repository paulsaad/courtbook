-- Phase 3 (2): club setup without SQL.
-- Admin: create/edit clubs, assign staff by email, set fee/active.
-- Staff: edit their club's hours, grid, booking limits, cutoff, hold, location; manage courts
--        and price rules (RLS already allows courts/price_rules writes for staff).

-- Staff may edit operational settings of their own club, but not name/slug/fee/active.
create or replace function update_club_settings(
  p_club uuid, p_open time, p_close time, p_slot int, p_min int, p_max int,
  p_cutoff int, p_hold int, p_window int, p_location text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_staff_of(p_club) then raise exception 'forbidden'; end if;
  update clubs set open_time = p_open, close_time = p_close, slot_minutes = p_slot,
    min_booking_minutes = p_min, max_booking_minutes = p_max, cancel_cutoff_hours = p_cutoff,
    hold_minutes = p_hold, booking_window_days = p_window, location_url = nullif(p_location, '')
  where id = p_club;
end $$;
revoke execute on function update_club_settings(uuid, time, time, int, int, int, int, int, int, text) from public, anon;
grant execute on function update_club_settings(uuid, time, time, int, int, int, int, int, int, text) to authenticated;

-- Admin assigns staff by email (profiles has no email; look it up in auth.users).
create or replace function add_club_staff(p_club uuid, p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then raise exception 'user_not_found'; end if;
  insert into club_staff (club_id, profile_id) values (p_club, v_id) on conflict do nothing;
  update profiles set roles = array_append(roles, 'staff') where id = v_id and not ('staff' = any(roles));
  return v_id::text;
end $$;
revoke execute on function add_club_staff(uuid, text) from public, anon;
grant execute on function add_club_staff(uuid, text) to authenticated;

create or replace function remove_club_staff(p_club uuid, p_profile uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  delete from club_staff where club_id = p_club and profile_id = p_profile;
end $$;
revoke execute on function remove_club_staff(uuid, uuid) from public, anon;
grant execute on function remove_club_staff(uuid, uuid) to authenticated;

-- Staff roster with names/emails for the admin screen
create or replace function club_staff_list(p_club uuid)
returns table (profile_id uuid, name text, email text)
language sql stable security definer set search_path = public as $$
  select s.profile_id, p.name, u.email::text
  from club_staff s join profiles p on p.id = s.profile_id join auth.users u on u.id = s.profile_id
  where s.club_id = p_club and is_staff_of(p_club);
$$;
revoke execute on function club_staff_list(uuid) from public, anon;
grant execute on function club_staff_list(uuid) to authenticated;

-- price_rules: staff can read/write their club's rules already; add a sort for display
alter table price_rules add column if not exists sort int not null default 0;
