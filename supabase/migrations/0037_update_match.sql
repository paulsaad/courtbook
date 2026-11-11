-- Phone test 21: organizer edits an open match (players needed, level, note, join mode).
-- Time and club are not editable (post a new match instead); linked bookings keep driving the time.
create or replace function update_match(p_match uuid, p_players_needed int, p_level player_level, p_note text, p_join_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare m matches%rowtype; n int;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into m from matches where id = p_match for update;
  if not found then raise exception 'not_found'; end if;
  if m.organizer_id <> auth.uid() then raise exception 'forbidden'; end if;
  if m.status = 'cancelled' or m.start_at <= now() then raise exception 'match_closed'; end if;
  if p_players_needed < 1 or p_players_needed > 20 then raise exception 'bad_players_needed'; end if;
  if p_join_mode not in ('open', 'approval') then raise exception 'bad_join_mode'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'note_too_long'; end if;
  select count(*) into n from match_players where match_id = p_match and status = 'accepted';
  if p_players_needed < n then raise exception 'below_accepted'; end if;
  update matches set players_needed = p_players_needed, level = p_level, note = nullif(trim(p_note), ''), join_mode = p_join_mode where id = p_match;
  -- capacity changed: close as full, or reopen an auto-closed match
  if m.status = 'open' and n >= p_players_needed then
    update matches set status = 'closed', closed_at = now(), closed_reason = 'full' where id = p_match;
  elsif m.status = 'closed' and m.closed_reason = 'full' and n < p_players_needed then
    update matches set status = 'open', closed_at = null, closed_reason = null where id = p_match;
  end if;
end $$;
revoke execute on function update_match(uuid, int, player_level, text, text) from public, anon;
grant execute on function update_match(uuid, int, player_level, text, text) to authenticated;
