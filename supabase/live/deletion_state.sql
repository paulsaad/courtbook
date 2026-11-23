-- READ ONLY. Every account-deletion record (0079) and the state of its account: dates, status and flags only.
-- No names, phones or emails; the account is shown by the first 8 characters of its id.
-- Question (23 Nov): was the separate test account's request withdrawn with "Keep my account"?
select left(d.subject_id::text, 8)                                              as account,
       d.status,
       d.requested_via                                                          as via,
       to_char(d.requested_at   at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as requested_beirut,
       to_char(d.cancelled_at   at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as kept_beirut,
       to_char(d.data_removed_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as data_removed_beirut,
       to_char(d.done_at        at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as done_beirut,
       p.id is not null                                                         as profile_exists,
       u.id is not null                                                         as sign_in_exists,
       coalesce(u.email = 'paul.tester@courtbook.test', false)                  as is_paul_tester,
       p.id is not null and p.name is null and p.phone is null                  as profile_emptied,
       deletion_requested(d.subject_id)                                         as pending_now,
       to_char(u.last_sign_in_at at time zone 'Asia/Beirut', 'Dy DD Mon HH24:MI') as last_sign_in_beirut
  from account_deletions d
  left join profiles p on p.id = d.subject_id
  left join auth.users u on u.id = d.subject_id
 order by d.requested_at;

-- Per account: how many records, how many still open (requested or data_removed). More than one open is impossible
-- by the unique index; this shows it.
select left(subject_id::text, 8) as account, count(*) as records,
       count(*) filter (where status in ('requested', 'data_removed')) as open_records,
       string_agg(status, ' → ' order by requested_at) as history
  from account_deletions group by subject_id order by min(requested_at);
