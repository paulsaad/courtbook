import subprocess
def q(db, sql):
    return [l for l in subprocess.run(["sudo","-u","postgres","psql","-X","-At","-F","\t","-d",db,"-c",sql],capture_output=True,text=True,check=True).stdout.split("\n") if l]
M = "md5(regexp_replace(prosrc, '[ \\t\\r]+(\\n|$)', '\\1', 'g'))"
FQ = f"select proname, pg_get_function_identity_arguments(oid), {M} from pg_proc where pronamespace='public'::regnamespace"
old = {(a,b):c for a,b,c in (l.split("\t") for l in q("cb_0077", FQ))}
new = {(a,b):c for a,b,c in (l.split("\t") for l in q("courtbook_test", FQ))}
changed = sorted(k for k in new if k in old and old[k] != new[k]); added = sorted(k for k in new if k not in old); removed = sorted(k for k in old if k not in new)
TQ = "select tgrelid::regclass::text || '.' || tgname from pg_trigger where not tgisinternal and tgrelid::regclass::text not like 'auth.%' and tgrelid::regclass::text not like 'storage.%'"
newtrig = sorted(set(q("courtbook_test", TQ)) - set(q("cb_0077", TQ)))
POLT = ["clubs", "courts", "price_rules", "club_media", "matches", "account_deletions", "moderation_log"]
PQ = lambda t: f"select coalesce(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ' | ' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = '{t}'"
pol_old = {t: q("cb_0077", PQ(t))[0] if q("cb_0077", PQ(t)) else "" for t in POLT}
pol_new = {t: q("courtbook_test", PQ(t))[0] if q("courtbook_test", PQ(t)) else "" for t in POLT}
lit = lambda s: "'" + s.replace("'", "''") + "'"
fsel = lambda n, a: f"(select {M} from pg_proc where pronamespace = 'public'::regnamespace and proname = {lit(n)} and pg_get_function_identity_arguments(oid) = {lit(a)})"
TRQ = "(select count(*)::int from pg_trigger where not tgisinternal and tgrelid::regclass::text || '.' || tgname = any(array[" + ",".join(lit(t) for t in newtrig) + "]))"
POL = lambda t: f"(select coalesce(string_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), ' | ' order by policyname), '') from pg_policies where schemaname = 'public' and tablename = {lit(t)})"
# extension members (btree_gist / pgcrypto support functions) are excluded: Supabase grants them to anon, they are not ours
# (0036 excludes them for the same reason)
ANON = "(select string_agg(p.proname, ',' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute') and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))"

anon_old = q("cb_0077", "select " + ANON)[0]; anon_new = q("courtbook_test", "select " + ANON)[0]

pre = ["-- launch-1 (migrations 0078–0084) — STAGING PREFLIGHT. READ ONLY: one SELECT, changes nothing.",
"-- Run immediately before applying 0078 0079 0080 0081 0082 0083 0084 (in that order). 0077 must be applied.",
"-- Every part-1 row must be ok = true, or nothing is applied. Part 2 is information (counts only, no personal data).",
"-- Generated from the schemas themselves (0077 vs integration/launch-1) by tools/gen_launch1_pack.py.",
"with checks(part, item, ok, detail) as (",
"  select 1, 'staging marker table exists (never run this on live)', to_regclass('staging_meta.applied') is not null, ''"]
for n,a in changed + removed:
    pre.append(f"  union all select 1, {lit(f'{n}: the 0077 version')}, {fsel(n,a)} is not distinct from {lit(old[(n,a)])}, coalesce({fsel(n,a)}, 'missing')")
pre.append(f"  union all select 1, 'none of the {len(added)} new functions exists yet (name and arguments)', not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname || '(' || pg_get_function_identity_arguments(oid) || ')' = any(array[{','.join(lit(n + '(' + a + ')') for n, a in added)}])), ''")
pre.append("  union all select 1, 'new tables and columns do not exist yet', to_regclass('public.account_deletions') is null and to_regclass('public.moderation_log') is null and not exists (select 1 from information_schema.columns where table_schema = 'public' and ((table_name = 'profiles' and column_name like 'age_confirmed%') or (table_name = 'clubs' and column_name like 'contact_%'))), ''")
pre.append(f"  union all select 1, 'none of the {len(newtrig)} new triggers exists yet', {TRQ} = 0, {TRQ}::text")
for t in ["clubs", "courts", "price_rules", "club_media", "matches"]:
    pre.append(f"  union all select 1, {lit(t + ' policies are the 0077 set')}, {POL(t)} = {lit(pol_old[t])}, {POL(t)}")
pre.append(f"  union all select 1, 'functions signed-out visitors can run: the 0077 list', {ANON} = {lit(anon_old)}, {ANON}")
pre += ["  union all select 1, 'neither switch is set yet', not exists (select 1 from app_settings where key in ('hide_demo_clubs', 'require_age_confirmation')), ''",
"  union all select 2, 'clubs (active / demo)', true, (select count(*) filter (where active) || ' / ' || count(*) filter (where is_demo) from clubs)",
"  union all select 2, 'accounts', true, (select count(*)::text from profiles)",
"  union all select 2, 'open reports', true, (select count(*)::text from reports where status = 'open')",
")", "select part, item, ok, detail from checks order by part, ok, item;"]

post = ["-- launch-1 (migrations 0078–0084) — STAGING POSTCHECK. READ ONLY: one SELECT, changes nothing.",
"-- Run right after applying 0078–0084 (and the demo seed the apply action runs). Every row must be ok = true.",
"-- Generated from the schemas themselves (0077 vs integration/launch-1) by tools/gen_launch1_pack.py.",
"with checks(item, ok, detail) as (",
"  select 'staging marker table exists (never run this on live)', to_regclass('staging_meta.applied') is not null, ''"]
post.append("  union all select 'all seven migrations recorded', (select count(*) from staging_meta.applied where name like any(array['0078_%','0079_%','0080_%','0081_%','0082_%','0083_%','0084_%'])) = 7, (select string_agg(name, ',' order by name) from staging_meta.applied where name >= '0078')")
for n,a in changed + added:
    post.append(f"  union all select {lit(f'{n}: the launch-1 version')}, {fsel(n,a)} is not distinct from {lit(new[(n,a)])}, coalesce({fsel(n,a)}, 'missing')")
for n,a in removed:
    post.append(f"  union all select {lit(f'{n}({a}): replaced (old signature gone)')}, {fsel(n,a)} is null, ''")
post.append("  union all select 'new tables and columns exist', to_regclass('public.account_deletions') is not null and to_regclass('public.moderation_log') is not null and (select count(*) from information_schema.columns where table_schema = 'public' and ((table_name = 'profiles' and column_name in ('age_confirmed_at','age_confirmed_via')) or (table_name = 'clubs' and column_name in ('contact_phone','contact_email')))) = 4, ''")
post.append(f"  union all select 'all {len(newtrig)} new triggers exist ({', '.join(newtrig)})', {TRQ} = {len(newtrig)}, {TRQ}::text || ' found'")
for t in POLT:
    post.append(f"  union all select {lit(t + ' policies are the launch-1 set')}, {POL(t)} = {lit(pol_new[t])}, {POL(t)}")
post.append(f"  union all select 'functions signed-out visitors can run: the launch-1 list', {ANON} = {lit(anon_new)}, {ANON}")
post += ["  union all select 'clients cannot read or write the new tables directly', not has_table_privilege('anon', 'account_deletions', 'select') and not has_table_privilege('authenticated', 'moderation_log', 'select') and not has_table_privilege('authenticated', 'account_deletions', 'insert'), ''",
"  union all select 'switch hide_demo_clubs not on (turned on separately, live only)', coalesce((select value from app_settings where key = 'hide_demo_clubs'), 'false') <> 'true', coalesce((select value from app_settings where key = 'hide_demo_clubs'), 'not set')",
"  union all select 'switch require_age_confirmation not on (turned on after the app update)', coalesce((select value from app_settings where key = 'require_age_confirmation'), 'false') <> 'true', coalesce((select value from app_settings where key = 'require_age_confirmation'), 'not set')",
"  union all select 'signed-out visitor: demo clubs still visible while the switch is off', (select count(*) from clubs where is_demo and club_readable_by_me(id, is_demo)) = (select count(*) from clubs where is_demo), ''",
"  union all select 'clubs already visible stay visible (the publish rule applies only to new publishing)', (select count(*) from clubs where active) > 0, (select count(*)::text from clubs where active)",
")", "select item, ok, detail from checks order by ok, item;"]
open("/home/claude/courtbook/supabase/live/launch1_preflight.sql","w").write("\n".join(pre) + "\n")
open("/home/claude/courtbook/supabase/live/launch1_postcheck.sql","w").write("\n".join(post) + "\n")
print(len(pre), len(post), len(newtrig))
