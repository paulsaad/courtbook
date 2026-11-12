-- Review of 0047's chain walk: a hold was treated as occupying its whole slot as long as the hold was
-- still alive *now*, even when the walk had moved on to a later time. So a block ending in 10 minutes
-- followed by a held booking for 10–70 minutes, on a hold that expires in 5, reported the court free in
-- 70 minutes. If nobody pays, that court is free in 10.
--
-- A pending booking occupies its slot only until its hold runs out: least(end_at, hold_expires_at).
-- Past that instant it holds nothing, which also covers a hold that expired before its slot began.
create or replace function club_courts_free_now(p_club uuid)
returns table (court_id uuid, court_name text, sport sport, busy boolean, free_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare k record; t timestamptz; nxt timestamptz;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not (is_staff_of(p_club) or is_admin()) then raise exception 'forbidden'; end if;
  for k in select c.id, c.name, c.sport from courts c where c.club_id = p_club and c.active order by c.name loop
    t := now();
    loop
      select max(x.ends) into nxt from (
        select case when b.status = 'pending' then least(b.end_at, b.hold_expires_at) else b.end_at end as ends,
               b.start_at
        from bookings b
        where b.club_id = p_club and b.court_id = k.id and b.status in ('confirmed', 'pending')
        union all
        select z.end_at, z.start_at from blocks z
        where z.club_id = p_club and z.court_id = k.id
      ) x
      where x.start_at <= t and x.ends > t;
      exit when nxt is null;          -- free from t onwards
      t := nxt;                       -- occupied until nxt; see whether something starts there
    end loop;
    court_id := k.id; court_name := k.name; sport := k.sport;
    busy := t > now();
    free_at := case when t > now() then t else null end;
    return next;
  end loop;
end $$;
revoke execute on function club_courts_free_now(uuid) from public, anon;
grant execute on function club_courts_free_now(uuid) to authenticated;
