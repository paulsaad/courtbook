-- Minimal stand-in for Supabase auth schema + default grants, for local tests only. Not used in production.
create schema auth;
create table auth.users (id uuid primary key, phone text, email text, raw_user_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
alter default privileges in schema public grant all on tables to authenticated, anon;
alter default privileges in schema public grant all on functions to authenticated, anon;
alter default privileges in schema public grant all on sequences to authenticated, anon;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema auth to service_role;
grant execute on function auth.uid() to service_role;
grant usage on schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on functions to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- Minimal stand-in for Supabase storage, so the policies guarding the club-media bucket are tested.
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text not null, owner uuid,
  created_at timestamptz default now());
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, anon, service_role;
grant select, insert, update, delete on storage.objects to authenticated, anon;
grant select on storage.buckets to authenticated, anon;
grant all on storage.objects, storage.buckets to service_role;
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
-- A broad write policy of the kind a project accumulates. The club-media guard must override it.
create policy "legacy: signed-in users may write" on storage.objects
  for all to authenticated using (true) with check (true);
