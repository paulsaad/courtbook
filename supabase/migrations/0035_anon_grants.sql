-- Phase 6 final review P1. Two tightenings:
-- (1) towns.created_by is a staff account id: column-level grants, nobody but service_role reads it.
-- (2) anon had Supabase's default SELECT grant on every table, with RLS as the only gate. Now anon may read
--     exactly the public set: clubs, courts, price_rules, sports, governorates, districts, towns (geography
--     columns), public_occupancy. Everything else is revoked, and future tables get no anon grant by default.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

grant select on clubs, courts, price_rules, sports, governorates, districts, public_occupancy to anon;

revoke all on towns from anon, authenticated;
grant select (id, district_code, name_en, name_ar, lat, lng, seeded, created_at) on towns to anon, authenticated;
grant insert, update, delete on towns to authenticated;   -- RLS "towns: admin" decides who may
