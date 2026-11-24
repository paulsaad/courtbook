-- 0092 — Club set-up: one price for all opening hours (with peak exceptions), and no court
-- hidden from the desk while it still has bookings (Mission 4, 24 Nov).
--
-- 1. set_club_base_prices(club, base, peaks, replace) — the shortcut a club employee needs.
--    It writes whole-club price rules covering the club's opening hours every day at `base` per hour. Each peak
--    { "start": "18:00", "end": "23:00", "price": 30, "days": 127 } takes its window on its days. The generated
--    rules never overlap, so quote_price always finds exactly one.
--    Existing whole-club rules are NEVER overwritten silently: with any present, it refuses 'prices_exist' unless
--    `replace` is true (the screen first shows what would be replaced). Court-specific rules are never touched; they
--    keep winning for their court.
--    Refuses peaks that overlap each other on a day ('peaks_overlap') or fall outside opening hours ('peak_outside_hours').
-- 2. (Already in place, not changed here: overlapping prices of the same scope are refused for every writer,
--    'price_rule_overlap', 0018/0019. The shortcut's rules never overlap by construction.)
-- 3. A court with upcoming bookings cannot be deactivated by anyone ('court_has_bookings'): website, app, the server's
--    own key and security-definer functions alike (review 24 Nov: no caller-based exemption). The staff
--    calendar shows active courts only, so those bookings would vanish from the desk while players still hold
--    them. Nothing is cancelled: the desk moves or cancels them first (no cascading cancellation without a
--    business decision).
-- 4. A published club keeps a price for every start time it offers (review 24 Nov). Players are shown every free
--    start time between opening and closing, and quote_price refuses a time without a price, so a gap reads as a
--    bookable slot that cannot be booked. Unpublished clubs were already covered: the checklist item 'prices'
--    (0081) lists the gap and publishing is refused. For a published, non-demo club these changes are now refused
--    ('prices_incomplete') when they leave a gap: longer opening hours or a different slot length, and deleting or
--    editing a price. Checked at the end of the request (deferred), so replacing prices in one step
--    (set_club_base_prices with replace) is fine. Shorter hours never create a gap and are never refused, even for a
--    club that already had one. To open longer: add a price for the extra time first, then change the hours.

-- ------------------------------------------------------------------ 1. one price for all opening hours
create or replace function set_club_base_prices(p_club uuid, p_base numeric, p_peaks jsonb default '[]'::jsonb, p_replace boolean default false)
returns int
language plpgsql security definer set search_path = public as $$
declare
  c clubs%rowtype;
  v_close time;
  d int;
  pk jsonb;
  bounds time[];
  seg_list jsonb;
  segs jsonb := '{}'::jsonb;     -- day pattern (as text) → mask
  k text;
  s jsonb;
  n int := 0;
  a time; b time; price numeric; label text;
  i int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  if p_base is null or p_base < 0 or p_base > 1000 then raise exception 'bad_price'; end if;
  if jsonb_typeof(coalesce(p_peaks, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_peaks, '[]'::jsonb)) > 6 then raise exception 'bad_peaks'; end if;
  select * into c from clubs where id = p_club for update;
  if not found then raise exception 'club_not_found'; end if;
  v_close := case when c.close_time = '00:00' then '24:00'::time else c.close_time end;
  if c.open_time >= v_close then raise exception 'bad_hours'; end if;

  for pk in select * from jsonb_array_elements(coalesce(p_peaks, '[]'::jsonb)) loop
    if (pk->>'start') is null or (pk->>'end') is null or (pk->>'price') is null then raise exception 'bad_peaks'; end if;
    if (pk->>'start')::time >= (pk->>'end')::time then raise exception 'bad_peaks'; end if;
    if (pk->>'price')::numeric < 0 or (pk->>'price')::numeric > 1000 then raise exception 'bad_price'; end if;
    if coalesce((pk->>'days')::int, 127) not between 1 and 127 then raise exception 'bad_peaks'; end if;
    if (pk->>'start')::time < c.open_time or (pk->>'end')::time > v_close then raise exception 'peak_outside_hours'; end if;
  end loop;

  -- for each weekday: the segments of the day and their prices, then days with the same pattern share one mask
  for d in 0..6 loop
    select array_agg(distinct x order by x) into bounds from (
      select c.open_time as x union all select v_close
      union all select (e->>'start')::time from jsonb_array_elements(coalesce(p_peaks, '[]'::jsonb)) e where (coalesce((e->>'days')::int, 127) & (1 << d)) <> 0
      union all select (e->>'end')::time from jsonb_array_elements(coalesce(p_peaks, '[]'::jsonb)) e where (coalesce((e->>'days')::int, 127) & (1 << d)) <> 0
    ) t;
    seg_list := '[]'::jsonb;
    for i in 1 .. array_length(bounds, 1) - 1 loop
      a := bounds[i]; b := bounds[i + 1];
      if (select count(*) from jsonb_array_elements(coalesce(p_peaks, '[]'::jsonb)) e
          where (coalesce((e->>'days')::int, 127) & (1 << d)) <> 0 and (e->>'start')::time <= a and b <= (e->>'end')::time) > 1 then
        raise exception 'peaks_overlap';
      end if;
      select (e->>'price')::numeric, coalesce(nullif(btrim(e->>'label'), ''), 'peak') into price, label
      from jsonb_array_elements(coalesce(p_peaks, '[]'::jsonb)) e
      where (coalesce((e->>'days')::int, 127) & (1 << d)) <> 0 and (e->>'start')::time <= a and b <= (e->>'end')::time
      limit 1;
      if price is null then price := p_base; label := null; end if;
      -- merge with the previous segment when the price and label are the same
      if jsonb_array_length(seg_list) > 0 and (seg_list->-1->>'price')::numeric = price and (seg_list->-1->>'label') is not distinct from label then
        seg_list := jsonb_set(seg_list, array[(jsonb_array_length(seg_list) - 1)::text, 'end'], to_jsonb(b::text));
      else
        seg_list := seg_list || jsonb_build_array(jsonb_build_object('start', a::text, 'end', b::text, 'price', price, 'label', label));
      end if;
      price := null; label := null;
    end loop;
    k := seg_list::text;
    segs := jsonb_set(segs, array[k], to_jsonb(coalesce((segs->>k)::int, 0) | (1 << d)));
  end loop;

  if exists (select 1 from price_rules where club_id = p_club and court_id is null) then
    if not p_replace then raise exception 'prices_exist'; end if;
    delete from price_rules where club_id = p_club and court_id is null;
  end if;
  for k in select jsonb_object_keys(segs) loop
    for s in select * from jsonb_array_elements(k::jsonb) loop
      insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label)
      values (p_club, null, (segs->>k)::int, (s->>'start')::time, (s->>'end')::time, (s->>'price')::numeric, s->>'label');
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function set_club_base_prices(uuid, numeric, jsonb, boolean) from public, anon;
grant execute on function set_club_base_prices(uuid, numeric, jsonb, boolean) to authenticated;

-- ------------------------------------------------------------------ 3. a court with bookings stays visible to the desk
create or replace function courts_keep_booked_active() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.active and not new.active and exists (
    select 1 from bookings where court_id = old.id and status in ('confirmed', 'pending') and end_at > now()
  ) then
    raise exception 'court_has_bookings';
  end if;
  return new;
end $$;
drop trigger if exists courts_keep_booked_active on courts;
create trigger courts_keep_booked_active before update of active on courts for each row execute function courts_keep_booked_active();


-- ------------------------------------------------------------------ 4. a published club stays fully priced
create or replace function club_prices_stay_complete() returns trigger
language plpgsql security definer set search_path = public as $$
declare cid uuid; gap text;
begin
  if tg_table_name = 'clubs' then
    cid := new.id;
    -- only changes that can open a gap: earlier opening, later closing, another slot length
    if not (new.open_time < old.open_time or new.close_time > old.close_time or new.slot_minutes <> old.slot_minutes) then
      return null;
    end if;
  else
    cid := old.club_id;
  end if;
  if not exists (select 1 from clubs where id = cid and active and not is_demo) then return null; end if;
  select detail into gap from club_readiness_rows(cid) where item = 'prices' and not ok;
  if gap is not null then raise exception 'prices_incomplete: %', gap; end if;
  return null;
end $$;
revoke all on function club_prices_stay_complete() from public;
drop trigger if exists clubs_prices_stay_complete on clubs;
create constraint trigger clubs_prices_stay_complete after update of open_time, close_time, slot_minutes on clubs
  deferrable initially deferred for each row execute function club_prices_stay_complete();
drop trigger if exists price_rules_stay_complete on price_rules;
create constraint trigger price_rules_stay_complete after delete or update on price_rules
  deferrable initially deferred for each row execute function club_prices_stay_complete();
