-- 0067 (match_detail) — ROLLBACK, all or nothing. Only if 0067 must be undone.
-- Restores the 0001–0071 schema exactly (checked by supabase/tests/m3/live_0067.sh). It stops, changing
-- nothing, if any game uses the new column or reason (nothing writes them before M3-H) or if M3-H is
-- applied (its functions depend on 0067). The app keeps working: with no match_detail it reports
-- "Game details arrive in the next update", and the web game page falls back to match_board.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $pre$ begin
  if not (exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_detail')
      and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'court_lost_at')) then
    raise exception 'STOPPED, nothing changed: 0067 is not applied here';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('resolve_court', 'remove_player')) then
    raise exception 'STOPPED, nothing changed: M3-H is applied and depends on 0067';
  end if;
  if exists (select 1 from matches where court_lost_at is not null or closed_reason = 'no_court') then
    raise exception 'STOPPED, nothing changed: some games use the court-lost state';
  end if;
end $pre$;
drop function if exists match_detail(uuid);
alter table matches drop constraint if exists matches_closed_reason_check;
alter table matches add constraint matches_closed_reason_check check (closed_reason in ('full', 'organizer'));
alter table matches drop column if exists court_lost_at;
do $post$ begin
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'match_detail')
     or exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'court_lost_at')
     or (select pg_get_constraintdef(oid) from pg_constraint where conname = 'matches_closed_reason_check')
        <> 'CHECK ((closed_reason = ANY (ARRAY[''full''::text, ''organizer''::text])))' then
    raise exception 'ROLLED BACK: the rollback did not land on the 0001–0071 schema';
  end if;
end $post$;
notify pgrst, 'reload schema';
commit;
select '0067 rolled back' as result;
