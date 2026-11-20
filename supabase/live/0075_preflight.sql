-- 0075 (moderator history: blocks received) — PREFLIGHT. READ ONLY. Every row must be ok = true.
-- On staging: Staging database workflow, action m3_0075_preflight.
with checks(item, ok, detail) as (
  select '0074 is applied (admin_reports and player_blocks exist)', to_regproc('public.admin_reports') is not null and to_regclass('public.player_blocks') is not null, ''
  union all select 'admin_blocks_received does not exist yet', to_regproc('public.admin_blocks_received') is null, ''
)
select item, ok, detail from checks order by item;
