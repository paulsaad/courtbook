-- The Photos panel refused every upload with "You cannot change this club's images", for the admin.
--
-- 0036 took away PostgreSQL's habit of granting EXECUTE on every new function to PUBLIC, and took
-- away Supabase's default grant to `authenticated` with it, leaving this comment: "every RPC gets an
-- explicit grant, as all migrations here already do." 0056 then wrote
--
--     revoke execute on function assert_club_editor(uuid) from public, anon;
--
-- and no grant. Every other function in 0056 got one. So the one function the browser has to call
-- before an upload — the check that asks whether this person may edit this club — was callable by
-- nobody, and the route turned the resulting insufficient_privilege into the same message it shows
-- someone who genuinely is not staff.
--
-- This is the only function affected: every other RPC that `authenticated` cannot execute is
-- deliberately service-role-only, which the test suite now asserts in both directions.
grant execute on function assert_club_editor(uuid) to authenticated;

-- What is actually deployed here, since the answer decides whether anything else is missing.
select p.oid::regprocedure::text as function,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as a_signed_in_user_may_call_it,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as the_server_may_call_it
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('assert_club_editor', 'assert_club_editor_as', 'assert_media_path',
                    'set_club_image', 'add_club_gallery', 'set_gallery_caption',
                    'reorder_club_gallery', 'remove_club_media', 'record_media_orphan',
                    'media_orphans_list', 'set_club_venue', 'storage_public_url')
order by 1;
