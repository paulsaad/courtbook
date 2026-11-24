-- Accounts and what would refuse their deletion — READ ONLY (SELECT only). No email addresses or names are printed:
-- the first 8 characters of each account id, its roles, club-staff memberships and any deletion record.
select left(u.id::text, 8) as account,
       coalesce(array_to_string(p.roles, ','), '-') as roles,
       (select count(*) from club_staff s where s.profile_id = u.id) as club_staff_of,
       coalesce((select string_agg(d.status::text, ',' order by d.requested_at) from account_deletions d where d.subject_id = u.id), '-') as deletion_records,
       case when 'admin' = any(p.roles) then 'refused: admin_role'
            when exists (select 1 from club_staff s where s.profile_id = u.id) then 'refused: staff_role'
            else 'player only: can request deletion' end as deletion_from_app,
       coalesce(to_char(u.last_sign_in_at, 'YYYY-MM-DD'), 'never') as last_sign_in
from auth.users u left join profiles p on p.id = u.id
order by u.created_at;
