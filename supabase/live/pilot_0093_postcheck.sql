-- 0093 (pilot, PR-8) — POSTCHECK. READ ONLY: one SELECT, changes nothing. Every row must be ok.
-- Fingerprints are md5(prosrc) of 0093's three definitions, as a 0001–0093 database has them.
with f(name, sig, want) as (values
  ('book_at_desk', 'book_at_desk(uuid,timestamptz,timestamptz,uuid)', 'f6c571b99b6ca295272babd15abd4976'),
  ('hold_slot', 'hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)', '48e016193fe384f65b4ee9c71b5e9e43'),
  ('request_account_deletion', 'request_account_deletion(text)', 'c28a53a4145e47ec9e9c8fb50919cd2b')
), checks(item, ok, detail) as (
  select 'the three functions are exactly 0093''s text',
    (select bool_and(coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure(f.sig)), '') = f.want) from f),
    (select string_agg(f.name || '=' || coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure(f.sig)), 'missing'), ' ') from f)
  union all select 'book_at_desk and hold_slot refuse a closed account after the profile lock and before any court',
    (select bool_and(position('for update' in prosrc) between 1 and position('if deletion_requested(v_player) then raise exception ''account_closed''; end if;' in prosrc)
                     and position('if deletion_requested(v_player) then raise exception ''account_closed''; end if;' in prosrc) between 1 and position('lock_courts(' in prosrc))
       from pg_proc where oid in (to_regprocedure('book_at_desk(uuid,timestamptz,timestamptz,uuid)'), to_regprocedure('hold_slot(uuid,uuid,timestamptz,timestamptz,uuid)'))), ''
  union all select 'request_account_deletion takes the profile lock before writing',
    coalesce((select position('from profiles where id = auth.uid() for update' in prosrc) between 1 and position('insert into account_deletions' in prosrc)
              from pg_proc where oid = to_regprocedure('request_account_deletion(text)')), false), ''
  union all select 'deletion_requested unchanged (the five open states)',
    coalesce((select md5(prosrc) from pg_proc where oid = to_regprocedure('deletion_requested(uuid)')), '') = 'dbb82744ee949b8113b676e86edac4cc', ''
  union all select 'grants and security unchanged: owner rights, search_path public; signed-in people and the service role may call them, visitors may not',
    (select bool_and(p.prosecdef and p.proconfig = array['search_path=public']
                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute'))
       from pg_proc p join f on p.oid = to_regprocedure(f.sig)), ''
  union all select 'nothing of M12 is here (no payment_attempts table)', to_regclass('public.payment_attempts') is null, ''
)
select item, ok, detail from checks;
