-- M12.1 (0093 fee_online payments) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok.
with checks(item, ok, detail) as (
  select 'tables payment_attempts and fee_charges exist, row security on', 
    coalesce((select bool_and(relrowsecurity) from pg_class where oid in (to_regclass('public.payment_attempts'), to_regclass('public.fee_charges'))), false)
    and to_regclass('public.payment_attempts') is not null and to_regclass('public.fee_charges') is not null, ''
  union all select 'no visitor or signed-in role may write either table',
    not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('payment_attempts', 'fee_charges')
                and grantee in ('anon', 'authenticated', 'public') and privilege_type <> 'SELECT')
    and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('payment_attempts', 'fee_charges') and grantee = 'anon'),
    coalesce((select string_agg(grantee || ':' || table_name || ':' || privilege_type, ', ') from information_schema.role_table_grants
              where table_schema = 'public' and table_name in ('payment_attempts', 'fee_charges') and grantee in ('anon', 'authenticated', 'public') and privilege_type <> 'SELECT'), '')
  union all select 'the two read policies are there (own attempts; fee charges admin only)',
    (select count(*) from pg_policies where schemaname = 'public' and tablename in ('payment_attempts', 'fee_charges')) = 2, ''
  union all select 'one kept charge per payment, one charge of its own per attempt, one refund reference per charge (unique indexes)',
    to_regclass('public.fee_charges_one_kept') is not null and to_regclass('public.fee_charges_one_per_attempt') is not null
    and to_regclass('public.fee_charges_refund_reference') is not null, ''
  union all select 'every existing payment is court_and_fee; the fee-only shape rule is in place',
    not exists (select 1 from payments where kind <> 'court_and_fee')
    and exists (select 1 from pg_constraint where conname = 'payments_fee_only_shape'), ''
  union all select 'server-only functions are not callable by visitors or signed-in people',
    not has_function_privilege('authenticated', 'record_attempt_result(uuid,text,text,numeric,text)', 'execute')
    and not has_function_privilege('anon', 'record_attempt_result(uuid,text,text,numeric,text)', 'execute')
    and not has_function_privilege('authenticated', 'reconcile_provider_charge(text,text,text,numeric,text)', 'execute')
    and not has_function_privilege('authenticated', 'open_payment_attempt(uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'abandon_payment_attempt(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'attempts_to_check(interval,interval,integer)', 'execute')
    and not has_function_privilege('authenticated', 'settle_payment_on_cancel(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'fee_charge_already_recorded(text,text,numeric,text,uuid)', 'execute')
    and has_function_privilege('service_role', 'record_attempt_result(uuid,text,text,numeric,text)', 'execute')
    and has_function_privilege('service_role', 'reconcile_provider_charge(text,text,text,numeric,text)', 'execute'), ''
  union all select 'players may start an attempt and admins complete a fee refund (both checked inside); visitors may not',
    has_function_privilege('authenticated', 'start_payment_attempt(uuid,uuid)', 'execute') and not has_function_privilege('anon', 'start_payment_attempt(uuid,uuid)', 'execute')
    and has_function_privilege('authenticated', 'complete_fee_refund(uuid,numeric,text,text)', 'execute') and not has_function_privilege('anon', 'complete_fee_refund(uuid,numeric,text,text)', 'execute')
    and not has_function_privilege('anon', 'fee_refunds_due()', 'execute'), ''
  union all select 'the replaced functions are 0093''s (fee-only guards present)',
    position('use_payment_attempts' in (select prosrc from pg_proc where oid = 'confirm_payment(uuid,text,numeric)'::regprocedure)) > 0
    and position('courtbook_fee_refund' in (select prosrc from pg_proc where oid = 'mark_refunded(uuid)'::regprocedure)) > 0
    and position('settle_payment_on_cancel' in (select prosrc from pg_proc where oid = 'cancel_booking(uuid,boolean)'::regprocedure)) > 0
    and position('settle_payment_on_cancel' in (select prosrc from pg_proc where oid = 'delete_account_data(uuid,boolean)'::regprocedure)) > 0
    and position('fee_online' in (select prosrc from pg_proc where oid = 'hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)'::regprocedure)) > 0, ''
  union all select 'real payments still off: no club takes fees online; no real provider configured in the database',
    not exists (select 1 from clubs where payment_mode = 'fee_online' and not is_demo)
    and coalesce(nullif(current_setting('app.payment_provider', true), ''), 'simulated') = 'simulated',
    coalesce((select string_agg(slug, ',') from clubs where payment_mode = 'fee_online' and not is_demo), '')
  union all select 'a real club in fee_online would not be publishable (club readiness still requires the desk)',
    position('c.payment_mode = ''at_desk'' or c.is_demo' in (select prosrc from pg_proc where oid = 'club_readiness_rows(uuid)'::regprocedure)) > 0, ''
  union all select 'no attempt, charge or fee-only payment exists yet',
    not exists (select 1 from payment_attempts) and not exists (select 1 from fee_charges) and not exists (select 1 from payments where kind = 'fee_only'), ''
  union all select 'every pending payment still belongs to a pending booking',
    not exists (select 1 from payments p join bookings b on b.id = p.booking_id where p.status = 'pending' and b.status <> 'pending'), ''
)
select item, ok, detail from checks order by ok, item;
