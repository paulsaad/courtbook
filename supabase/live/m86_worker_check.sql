-- M2 (0086), R1 activation check: is the deletion retry worker running? READ ONLY. No account ids, no emails.
-- Gate (review 23 Nov, finding 1): the app's one-step deletion is released only after this shows a heartbeat under
-- 1 hour old following several scheduled runs, and no record needing attention.
\pset footer off
select to_regclass('public.deletion_worker') is not null as has_0086 \gset
\if :has_0086
  select last_run_at, round(extract(epoch from now() - last_run_at) / 60) as minutes_ago,
         deletion_processing_active() as app_deletion_open, last_counts
    from deletion_worker;
  select 'no heartbeat recorded yet' as worker where not exists (select 1 from deletion_worker);
  select status, count(*) as records, count(*) filter (where last_error is not null) as with_error,
         min(coalesce(closing_at, requested_at)) as oldest
    from account_deletions where status not in ('done', 'cancelled') group by status order by status;
  select count(*) as needing_attention from deletions_needing_attention();
\else
  select '0086 is not applied here: nothing to check' as status;
\endif
