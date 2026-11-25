-- M12.2 (0095 payment reconciliation) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok.
with checks(item, ok, detail) as (
  select 'tables payment_reconciliation and payment_reconciliation_issues exist, row security on',
    to_regclass('public.payment_reconciliation') is not null and to_regclass('public.payment_reconciliation_issues') is not null
    and coalesce((select bool_and(relrowsecurity) from pg_class where oid in (to_regclass('public.payment_reconciliation'), to_regclass('public.payment_reconciliation_issues'))), false), ''
  union all select 'visitors have no access to either table; signed-in people may only read issues (admins, by policy); the watermark is server only',
    not exists (select 1 from information_schema.role_table_grants where table_schema = 'public'
                and table_name in ('payment_reconciliation', 'payment_reconciliation_issues') and grantee in ('anon', 'public'))
    and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and grantee = 'authenticated'
                and (table_name = 'payment_reconciliation' or (table_name = 'payment_reconciliation_issues' and privilege_type <> 'SELECT'))),
    coalesce((select string_agg(grantee || ':' || table_name || ':' || privilege_type, ', ') from information_schema.role_table_grants
              where table_schema = 'public' and table_name in ('payment_reconciliation', 'payment_reconciliation_issues')
                and grantee in ('anon', 'public', 'authenticated')), '')
  union all select 'exactly one read policy (issues, admins); none on the watermark',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'payment_reconciliation_issues') = 1
    and position('is_admin()' in coalesce((select qual from pg_policies where schemaname = 'public' and tablename = 'payment_reconciliation_issues'), '')) > 0
    and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_reconciliation'), ''
  union all select 'watermark, issue recording and health are server only (service key), not callable by visitors or signed-in people',
    not has_function_privilege('authenticated', 'initialise_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'advance_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'rewind_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'record_reconciliation_issue(text,text,text,numeric,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'payment_reconciliation_health(text,interval)', 'execute')
    and not has_function_privilege('anon', 'initialise_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'advance_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'rewind_reconciliation_watermark(text,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'record_reconciliation_issue(text,text,text,numeric,text,text)', 'execute')
    and not has_function_privilege('anon', 'payment_reconciliation_health(text,interval)', 'execute')
    and has_function_privilege('service_role', 'advance_reconciliation_watermark(text,timestamptz)', 'execute')
    and has_function_privilege('service_role', 'record_reconciliation_issue(text,text,text,numeric,text,text)', 'execute')
    and has_function_privilege('service_role', 'payment_reconciliation_health(text,interval)', 'execute'), ''
  union all select 'resolving an issue: signed-in (admin checked inside), never visitors',
    has_function_privilege('authenticated', 'resolve_reconciliation_issue(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'resolve_reconciliation_issue(uuid,text)', 'execute')
    and position('is_admin()' in (select prosrc from pg_proc where oid = 'resolve_reconciliation_issue(uuid,text)'::regprocedure)) > 0, ''
  union all select 'every 0095 function runs as its owner with a fixed search_path',
    (select bool_and(p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%') from pg_proc p
      where p.oid in ('initialise_reconciliation_watermark(text,timestamptz)'::regprocedure, 'advance_reconciliation_watermark(text,timestamptz)'::regprocedure,
                      'rewind_reconciliation_watermark(text,timestamptz)'::regprocedure, 'record_reconciliation_issue(text,text,text,numeric,text,text)'::regprocedure,
                      'resolve_reconciliation_issue(uuid,text)'::regprocedure, 'payment_reconciliation_health(text,interval)'::regprocedure)), ''
  union all select 'no starting point is set: the runner reads no provider charge list until a person initialises it',
    not exists (select 1 from payment_reconciliation), coalesce((select string_agg(provider, ',') from payment_reconciliation), '')
  union all select 'no reconciliation issue exists yet',
    not exists (select 1 from payment_reconciliation_issues), (select count(*)::text from payment_reconciliation_issues)
  union all select '0095 replaced nothing: 0094''s payment functions are unchanged (fee-only guards present)',
    position('use_payment_attempts' in (select prosrc from pg_proc where oid = 'confirm_payment(uuid,text,numeric)'::regprocedure)) > 0
    and position('settle_payment_on_cancel' in (select prosrc from pg_proc where oid = 'cancel_booking(uuid,boolean)'::regprocedure)) > 0, ''
  union all select 'real payments still off: no real club takes fees online; no real provider configured in the database',
    not exists (select 1 from clubs where payment_mode = 'fee_online' and not is_demo)
    and coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated') = 'simulated', ''
)
select item, ok, detail from checks order by ok, item;
