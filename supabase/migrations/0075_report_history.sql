-- 0075 — moderator history for reported players (CANDIDATE: applied nowhere).
-- docs/m3/05-architecture.md §5.6 "Reviews": the Reports page shows the reported player's history —
-- earlier reports (admin_reports.reports_against, 0074) and blocks received (this function).
-- Additive: one admin-only function; nothing existing changes. Needs 0074. Rollback: drop the function
-- (supabase/live/0075_rollback.sql).
create or replace function admin_blocks_received(p_profiles uuid[])
returns table (profile_id uuid, blocks_received int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select p.id, (select count(*)::int from player_blocks b where b.blocked_id = p.id)
  from profiles p where p.id = any(coalesce(p_profiles, '{}'));
end $$;
revoke all on function admin_blocks_received(uuid[]) from public, anon;
grant execute on function admin_blocks_received(uuid[]) to authenticated;
notify pgrst, 'reload schema';
