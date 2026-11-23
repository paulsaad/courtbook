-- 0081 — Club onboarding readiness (master launch checklist M8).
--
-- A real club becomes operational through the existing admin screens (create, location, hours and booking rules,
-- courts, prices, staff). What was missing, and is added here:
--   1. contact details (phone required, email optional) — clubs had none;
--   2. a readiness check, computed by the database from the club's actual configuration;
--   3. a new club starts hidden, and "Visible to players" is refused until the readiness check passes, so an
--      incomplete club cannot become publicly bookable by accident (before: clubs.active defaulted to true, so a club
--      was public from its first save, and bookable — failing with "no price" — as soon as it had a court).
-- Server work (auth.uid() null: seeds, the SQL editor) is unaffected. Clubs already visible stay visible; the
-- checklist shows what they lack. No booking rule, price calculation or payment behaviour changes.

alter table clubs add column if not exists contact_phone text;
alter table clubs add column if not exists contact_email text;
do $$ begin
  alter table clubs add constraint clubs_contact_phone_check check (contact_phone is null or contact_phone ~ '^\+?[0-9][0-9 ()-]{5,24}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table clubs add constraint clubs_contact_email_check check (contact_email is null or (char_length(contact_email) <= 120 and contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));
exception when duplicate_object then null; end $$;

-- contact: the club's staff or an admin
create or replace function set_club_contact(p_club uuid, p_phone text, p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;   -- contact: own club only
  update clubs set contact_phone = nullif(btrim(p_phone), ''), contact_email = nullif(lower(btrim(p_email)), '') where id = p_club;
  if not found then raise exception 'not_found'; end if;
exception when check_violation then raise exception 'bad_contact';
end $$;
revoke all on function set_club_contact(uuid, text, text) from public, anon, authenticated;
grant execute on function set_club_contact(uuid, text, text) to authenticated, service_role;

-- the checks, in the order an admin works through them. Internal (no permission check): club_readiness wraps it.
create or replace function club_readiness_rows(p_club uuid)
returns table (item text, ok boolean, detail text)
language plpgsql stable security definer set search_path = public as $$
declare
  c clubs%rowtype;
  n int; gap text; dup text;
  open_min int; close_min int;
begin
  select * into c from clubs where id = p_club;
  if not found then return; end if;
  open_min := (extract(epoch from c.open_time) / 60)::int;
  close_min := (extract(epoch from c.close_time) / 60)::int;     -- 24:00 counts as 1440

  item := 'name'; ok := btrim(c.name) <> ''; detail := null; return next;
  item := 'location'; ok := c.town_id is not null and (nullif(btrim(coalesce(c.address, '')), '') is not null or nullif(btrim(coalesce(c.location_url, '')), '') is not null);
    detail := case when c.town_id is null then 'choose the town' when ok then null else 'add the address or a map link' end; return next;
  item := 'contact'; ok := c.contact_phone is not null; detail := case when ok then null else 'add a phone number players can call' end; return next;
  item := 'hours'; ok := close_min > open_min and close_min - open_min >= c.min_booking_minutes;
    detail := case when ok then null else 'opening hours are shorter than the shortest booking' end; return next;
  select count(*) into n from courts where club_id = p_club and active;
  item := 'courts'; ok := n > 0; detail := case when ok then n || ' active' else 'add at least one court' end; return next;
  -- every start time on the grid, every weekday, every active court has a price (what quote_price needs)
  select k.name || ', ' || (array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'])[d + 1] || ' '
         || to_char(make_interval(mins => m), 'HH24:MI'), count(*) over ()
    into gap, n
    from courts k
    cross join generate_series(0, 6) d
    cross join generate_series(open_min, close_min - c.slot_minutes, c.slot_minutes) m
   where k.club_id = p_club and k.active
     and not exists (select 1 from price_rules pr
                      where pr.club_id = p_club and (pr.court_id = k.id or pr.court_id is null)
                        and (pr.weekday_mask & (1 << d)) <> 0
                        and pr.start_time <= make_interval(mins => m)::time
                        and (make_interval(mins => m)::time < pr.end_time))
   order by k.sort, d, m limit 1;
  item := 'prices'; ok := gap is null and exists (select 1 from courts where club_id = p_club and active);
    detail := case when gap is not null then 'no price for ' || gap || case when n > 1 then ' and ' || (n - 1) || ' more start times' else '' end
                   when not ok then 'add courts first' end; return next;
  -- two rules of the same kind (same court, or both club-wide) covering the same weekday and time: which one a booking
  -- gets would be arbitrary
  select coalesce(k.name, 'all courts') || ', ' || to_char(a.start_time, 'HH24:MI') || '–' || to_char(a.end_time, 'HH24:MI')
    into dup
    from price_rules a join price_rules b on b.club_id = a.club_id and b.id > a.id
         and b.court_id is not distinct from a.court_id and (a.weekday_mask & b.weekday_mask) <> 0
         and a.start_time < b.end_time and b.start_time < a.end_time
    left join courts k on k.id = a.court_id
   where a.club_id = p_club limit 1;
  item := 'prices_unambiguous'; ok := dup is null; detail := case when ok then null else 'two prices overlap: ' || dup end; return next;
  select count(*) into n from club_staff where club_id = p_club;
  item := 'staff'; ok := n > 0; detail := case when ok then n || ' assigned' else 'assign at least one desk account' end; return next;
  item := 'payment'; ok := c.payment_mode = 'at_desk' or c.is_demo;
    detail := case when ok then null else 'real clubs take payment at the desk until online payments exist' end; return next;
end $$;
revoke all on function club_readiness_rows(uuid) from public, anon, authenticated;
grant execute on function club_readiness_rows(uuid) to service_role;

create or replace function club_readiness(p_club uuid)
returns table (item text, ok boolean, detail text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;   -- checklist: own club only
  return query select * from club_readiness_rows(p_club);
end $$;
revoke all on function club_readiness(uuid) from public, anon, authenticated;
grant execute on function club_readiness(uuid) to authenticated, service_role;

-- new clubs start hidden; making a club visible requires every check to pass (signed-in requests; server work trusted)
create or replace function clubs_publish_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare missing text;
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    new.active := false;                    -- a new club cannot be ready: it has no courts, prices or staff yet
    return new;
  end if;
  if new.active and not old.active then
    select string_agg(item, ', ') into missing from club_readiness_rows(new.id) where not ok;
    if missing is not null then raise exception 'club_not_ready: %', missing; end if;
  end if;
  return new;
end $$;
revoke all on function clubs_publish_guard() from public, anon, authenticated;
drop trigger if exists clubs_publish_guard on clubs;
create trigger clubs_publish_guard before insert or update of active on clubs for each row execute function clubs_publish_guard();
