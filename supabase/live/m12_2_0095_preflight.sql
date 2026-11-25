-- M12.2 (0095 payment reconciliation) — PREFLIGHT. READ ONLY: one SELECT, changes nothing.
-- Part 1 rows must all be ok before applying 0095; part 2 is information to note in the run log.
with checks(part, item, ok, detail) as (
  select 1, '0094 is applied (payment attempts and fee charges, which 0095 reads)',
    to_regclass('public.payment_attempts') is not null and to_regclass('public.fee_charges') is not null
    and to_regprocedure('record_attempt_result(uuid,text,text,numeric,text)') is not null
    and to_regprocedure('reconcile_provider_charge(text,text,text,numeric,text)') is not null, ''
  union all select 1, 'what 0095 needs is here (profiles, is_admin, gen_random_uuid)',
    to_regclass('public.profiles') is not null and to_regprocedure('is_admin()') is not null and to_regprocedure('gen_random_uuid()') is not null, ''
  union all select 1, 'nothing of 0095 is here yet (no half-applied migration)',
    to_regclass('public.payment_reconciliation') is null and to_regclass('public.payment_reconciliation_issues') is null
    and to_regprocedure('initialise_reconciliation_watermark(text,timestamptz)') is null
    and to_regprocedure('advance_reconciliation_watermark(text,timestamptz)') is null
    and to_regprocedure('rewind_reconciliation_watermark(text,timestamptz)') is null
    and to_regprocedure('record_reconciliation_issue(text,text,text,numeric,text,text)') is null
    and to_regprocedure('resolve_reconciliation_issue(uuid,text)') is null
    and to_regprocedure('payment_reconciliation_health(text,interval)') is null, ''
  union all select 1, 'real payments still off: no real club takes fees online; no real provider configured in the database',
    not exists (select 1 from clubs where payment_mode = 'fee_online' and not is_demo)
    and coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated') = 'simulated',
    coalesce((select string_agg(left(id::text, 8), ',') from clubs where payment_mode = 'fee_online' and not is_demo), '')
  union all select 1, 'every attempt and payment provider is one 0095 knows (simulated, whish, areeba)',
    not exists (select 1 from payment_attempts where provider not in ('simulated', 'whish', 'areeba'))
    and not exists (select 1 from payments where provider not in ('simulated', 'whish', 'areeba')), ''
  -- information (counts only)
  union all select 2, 'payment attempts by provider and status',
    true, coalesce((select string_agg(provider || ':' || status || '=' || n, ', ' order by provider, status) from (select provider, status::text, count(*) n from payment_attempts group by 1, 2) x), 'none')
  union all select 2, 'fee charges by disposition',
    true, coalesce((select string_agg(disposition || '=' || n, ', ' order by disposition) from (select disposition::text, count(*) n from fee_charges group by 1) x), 'none')
)
select part, item, ok, detail from checks order by part, ok, item;
