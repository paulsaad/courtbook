-- How accounts created since the deletion trial began (2026-11-24 17:22Z baseline) came about — READ ONLY (SELECT only).
-- Prints no email address, name, phone, IP address, user agent or token: the first 8 characters of the account id,
-- times (UTC, to the second), the sign-in method and which metadata KEYS exist (never their values).
-- The workflow log of this public repository is public: keep it that way.
\pset footer off
\echo '== accounts created after the trial baseline'
select left(u.id::text, 8) as account,
       to_char(u.created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as created_utc,
       coalesce(u.raw_app_meta_data->>'provider', '-') as first_provider,
       coalesce((select string_agg(x, ',') from jsonb_array_elements_text(coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb)) x), '-') as providers,
       coalesce(to_char(u.confirmation_sent_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as confirmation_sent_utc,
       coalesce(to_char(u.email_confirmed_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as email_confirmed_utc,
       coalesce(to_char(u.last_sign_in_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), 'never') as last_sign_in_utc,
       coalesce(to_char(u.invited_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as invited_utc,
       coalesce((to_jsonb(u)->>'is_anonymous'), '-') as anonymous,
       u.is_sso_user as sso,
       (u.phone is not null and u.phone <> '') as has_phone,
       (u.encrypted_password is not null and u.encrypted_password <> '') as has_password,
       case when u.email is null then 'none' when u.email like '%@courtbook.test' then 'courtbook.test'
            when split_part(u.email, '@', 2) in ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'privaterelay.appleid.com') then split_part(u.email, '@', 2)
            else 'other' end as email_domain,
       coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(coalesce(u.raw_user_meta_data, '{}'::jsonb)) k), '-') as user_metadata_keys,
       (select count(*) from auth.sessions s where s.user_id = u.id) as sessions,
       (select count(*) from auth.refresh_tokens r where r.user_id::text = u.id::text) as refresh_tokens,
       coalesce(to_char((select p.created_at from public.profiles p where p.id = u.id) at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as profile_created_utc
from auth.users u
where u.created_at > '2026-11-24 17:22:00+00'
order by u.created_at;

\echo '== their sign-in identities (provider and times; identity data keys only)'
select left(i.user_id::text, 8) as account, i.provider,
       to_char(i.created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as created_utc,
       coalesce(to_char(i.last_sign_in_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), 'never') as last_sign_in_utc,
       coalesce((select string_agg(k, ',' order by k) from jsonb_object_keys(coalesce(i.identity_data, '{}'::jsonb)) k), '-') as identity_data_keys
from auth.identities i join auth.users u on u.id = i.user_id
where u.created_at > '2026-11-24 17:22:00+00'
order by i.created_at;

\echo '== sign-in flows (PKCE) since the baseline: method, provider, whether the code was issued/exchanged (no codes)'
select coalesce(left(f.user_id::text, 8), '-') as account, f.provider_type, f.authentication_method,
       to_char(f.created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as created_utc,
       coalesce(to_char(f.auth_code_issued_at at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as code_issued_utc
from auth.flow_state f
where f.created_at > '2026-11-24 17:22:00+00'
order by f.created_at;

\echo '== one-time tokens for those accounts (type and time only)'
select left(t.user_id::text, 8) as account, t.token_type,
       to_char(t.created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as created_utc
from auth.one_time_tokens t join auth.users u on u.id = t.user_id
where u.created_at > '2026-11-24 17:22:00+00'
order by t.created_at;

\echo '== Auth audit log since the baseline: action, type, time, account (id prefix) and provider only (no address, no IP)'
select to_char(a.created_at at time zone 'UTC', 'MM-DD HH24:MI:SS') as at_utc,
       coalesce(a.payload->>'action', '-') as action,
       coalesce(a.payload->>'log_type', '-') as log_type,
       coalesce(left(a.payload->>'actor_id', 8), '-') as actor,
       coalesce(a.payload->'traits'->>'provider', '-') as provider
from auth.audit_log_entries a
where a.created_at > '2026-11-24 17:22:00+00'
order by a.created_at
limit 200;
\echo '== audit log rows in total and newest (to tell an empty log from a disabled one)'
select count(*) as rows, coalesce(to_char(max(created_at) at time zone 'UTC', 'MM-DD HH24:MI:SS'), '-') as newest_utc from auth.audit_log_entries;
