-- 0082 — Support and moderation readiness (master launch checklist M10). Reuses the M3-S foundation (reports,
-- suspensions, the admin_* functions and /admin/reports); adds what real report handling needs:
--   1. an append-only moderation log: who did what, when and why (suspend, unsuspend, hide a message, resolve,
--      reopen, legal hold, text clearing). Unsuspending used to delete the only record that a suspension happened.
--   2. safe actions: a handled report cannot be resolved again over the first decision (reopen it, with a note);
--      an admin cannot be suspended (remove the role first); unsuspending needs a reason;
--   3. legal hold, settable by admins (the column existed, nothing could set it);
--   4. the 180-day clearing of report text (snapshot and note), skipping reports on legal hold and open ones.
-- Every function checks is_admin() itself; the tables have no client grants. The log keeps ids, not names.

create table if not exists moderation_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default clock_timestamp(),   -- the true order of actions, also within one transaction
  admin_id uuid references profiles(id) on delete set null,
  action text not null check (action in ('resolve', 'reopen', 'suspend', 'unsuspend', 'hide_message', 'legal_hold_on', 'legal_hold_off', 'clear_text')),
  report_id uuid references reports(id) on delete set null,
  profile_id uuid,            -- the account acted on; no foreign key: the record outlives the account
  message_id uuid,            -- likewise
  note text check (char_length(coalesce(note, '')) <= 1000)
);
alter table moderation_log alter column at set default clock_timestamp();
create index if not exists moderation_log_report_idx on moderation_log (report_id, at);
create index if not exists moderation_log_profile_idx on moderation_log (profile_id, at);
alter table moderation_log enable row level security;
revoke all on moderation_log from anon, authenticated;
-- append-only, also for the service role and the SQL editor (corrections are new rows, never edits). The one change
-- ever allowed is the retention rule below clearing a note: only inside enforce_report_retention, and only note → null.
create or replace function moderation_log_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and current_setting('courtbook.moderation_log_retention', true) = 'on'
     and new.note is null and (new.id, new.at, new.admin_id, new.action, new.report_id, new.profile_id, new.message_id)
         is not distinct from (old.id, old.at, old.admin_id, old.action, old.report_id, old.profile_id, old.message_id) then
    return new;
  end if;
  raise exception 'moderation_log_is_append_only';
end $$;
drop trigger if exists moderation_log_append_only on moderation_log;
create trigger moderation_log_append_only before update or delete on moderation_log
  for each row execute function moderation_log_append_only();

create or replace function log_moderation(p_action text, p_report uuid, p_profile uuid, p_message uuid, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into moderation_log (admin_id, action, report_id, profile_id, message_id, note)
  values (auth.uid(), p_action, p_report, p_profile, p_message, nullif(left(btrim(coalesce(p_note, '')), 1000), ''));
$$;
revoke all on function log_moderation(text, uuid, uuid, uuid, text) from public, anon, authenticated;

-- ============ actions (same signatures; each now checks its target's state and writes the log) ============
create or replace function admin_resolve_report(p_report uuid, p_status text, p_action text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_status not in ('actioned', 'dismissed') then raise exception 'bad_status'; end if;
  select * into r from reports where id = p_report for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'open' then raise exception 'already_handled'; end if;        -- reopen first: the first decision stays on record
  update reports set status = p_status, action = nullif(trim(coalesce(p_action, '')), ''), handled_by = auth.uid(),
         handled_at = now(), closed_at = now()
   where id = p_report;
  perform log_moderation('resolve', p_report, r.profile_id, r.message_id, p_status || coalesce(': ' || nullif(trim(coalesce(p_action, '')), ''), ''));
end $$;

create or replace function admin_reopen_report(p_report uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required'; end if;
  select * into r from reports where id = p_report for update;
  if not found then raise exception 'not_found'; end if;
  if r.status = 'open' then raise exception 'already_open'; end if;
  -- the earlier decision is in the log; the report is open again and its clearing clock stops (closed_at null)
  update reports set status = 'open', closed_at = null where id = p_report;
  perform log_moderation('reopen', p_report, r.profile_id, r.message_id, 'was ' || r.status || coalesce(' (' || r.action || ')', '') || ': ' || trim(p_note));
end $$;

create or replace function admin_suspend(p_profile uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_profile = auth.uid() then raise exception 'bad_target'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if not exists (select 1 from profiles where id = p_profile) then raise exception 'not_found'; end if;
  if exists (select 1 from profiles where id = p_profile and 'admin' = any(roles)) then raise exception 'bad_target'; end if;
  insert into account_suspensions (profile_id, reason, suspended_by) values (p_profile, trim(p_reason), auth.uid())
  on conflict (profile_id) do update set reason = excluded.reason, suspended_by = excluded.suspended_by;
  perform log_moderation('suspend', null, p_profile, null, trim(p_reason));
end $$;

-- the old one-argument version had no reason; it is replaced (the admin page sends a reason)
drop function if exists admin_unsuspend(uuid);
create or replace function admin_unsuspend(p_profile uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s account_suspensions%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_required'; end if;   -- unsuspend: a reason is kept
  delete from account_suspensions where profile_id = p_profile returning * into s;
  if not found then raise exception 'not_suspended'; end if;
  -- the suspension row is gone; its date and reason stay in the log
  perform log_moderation('unsuspend', null, p_profile, null,
    trim(p_reason) || ' (suspended ' || to_char(s.suspended_at at time zone 'Asia/Beirut', 'YYYY-MM-DD') || ': ' || s.reason || ')');
end $$;

create or replace function admin_hide_message(p_message uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m match_messages%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update match_messages set body = '', deleted_at = now() where id = p_message and deleted_at is null returning * into m;
  if found then
    -- the text of a reported message stays in its report's snapshot (evidence); the log records the action
    perform log_moderation('hide_message', (select id from reports where message_id = p_message order by created_at limit 1), m.profile_id, p_message, null);
  end if;
end $$;

create or replace function admin_set_legal_hold(p_report uuid, p_hold boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare r reports%rowtype;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'reason_required'; end if;
  select * into r from reports where id = p_report for update;
  if not found then raise exception 'not_found'; end if;
  if r.legal_hold = coalesce(p_hold, false) then return; end if;
  update reports set legal_hold = coalesce(p_hold, false) where id = p_report;
  perform log_moderation(case when p_hold then 'legal_hold_on' else 'legal_hold_off' end, p_report, r.profile_id, r.message_id, trim(p_note));
end $$;

-- The 180-day rule, enforced without a scheduler:
--   * report text: once a report has been closed for 180 days, its free text (snapshot of the reported content,
--     reporter's note) is cleared. Open reports and reports on legal hold are kept. The row (kind, reason, dates,
--     decision) stays.
--   * moderation-log notes (free text written by admins): cleared once the entry is 180 days old, unless its report
--     is still open or on legal hold, or it concerns a suspension still in force. Action, date and ids stay.
-- Runs on every new report (trigger) and whenever an admin opens the reports page; admins can also run it by hand.
create or replace function enforce_report_retention(p_days int default 180) returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  if p_days is null or p_days < 180 then raise exception 'too_soon'; end if;   -- never earlier than the stated rule
  update reports set snapshot = null, note = null
   where status <> 'open' and not legal_hold and closed_at is not null and closed_at < now() - make_interval(days => p_days)
     and (snapshot is not null or note is not null);
  get diagnostics n = row_count;
  perform set_config('courtbook.moderation_log_retention', 'on', true);
  update moderation_log l set note = null
   where l.note is not null and l.action <> 'clear_text' and l.at < now() - make_interval(days => p_days)
     and not exists (select 1 from reports r where r.id = l.report_id and (r.status = 'open' or r.legal_hold))
     and not (l.action in ('suspend', 'unsuspend') and exists (select 1 from account_suspensions s where s.profile_id = l.profile_id));
  get diagnostics m = row_count;
  perform set_config('courtbook.moderation_log_retention', '', true);
  if n + m > 0 then
    insert into moderation_log (admin_id, action, note)      -- run by a player's new report: no admin recorded
    values (case when is_admin() then auth.uid() end, 'clear_text', n || ' report text(s) and ' || m || ' log note(s) older than ' || p_days || ' days');
  end if;
  return n + m;
end $$;
revoke all on function enforce_report_retention(int) from public, anon, authenticated;

-- admins (the reports page calls it on every visit) and server jobs
create or replace function clear_old_report_text(p_days int default 180) returns int
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  return enforce_report_retention(p_days);
end $$;

-- every new report (filed by any player) also runs it, so the rule holds even if no admin visits for months
create or replace function reports_enforce_retention() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform enforce_report_retention(180);
  return null;
end $$;
revoke all on function reports_enforce_retention() from public, anon, authenticated;
drop trigger if exists reports_enforce_retention on reports;
create trigger reports_enforce_retention after insert on reports for each statement execute function reports_enforce_retention();

-- ============ reading ============
create or replace function admin_moderation_log(p_report uuid default null, p_profile uuid default null)
returns table (at timestamptz, admin_name text, action text, report_id uuid, profile_id uuid, message_id uuid, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select l.at, p.name, l.action, l.report_id, l.profile_id, l.message_id, l.note
    from moderation_log l left join profiles p on p.id = l.admin_id
   where (p_report is null or l.report_id = p_report) and (p_profile is null or l.profile_id = p_profile)
   order by l.at desc limit 200;
end $$;

-- extra state for the reports board (admin_reports keeps its shape): legal hold, who handled it, history size
create or replace function admin_report_state(p_reports uuid[])
returns table (report_id uuid, legal_hold boolean, handled_by_name text, closed_at timestamptz, log_entries int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select r.id, r.legal_hold, h.name, r.closed_at,
         (select count(*)::int from moderation_log l where l.report_id = r.id or (r.profile_id is not null and l.profile_id = r.profile_id))
    from reports r left join profiles h on h.id = r.handled_by
   where r.id = any(p_reports);
end $$;

revoke all on function admin_resolve_report(uuid, text, text) from public, anon, authenticated;
revoke all on function admin_reopen_report(uuid, text) from public, anon, authenticated;
revoke all on function admin_suspend(uuid, text) from public, anon, authenticated;
revoke all on function admin_unsuspend(uuid, text) from public, anon, authenticated;
revoke all on function admin_hide_message(uuid) from public, anon, authenticated;
revoke all on function admin_set_legal_hold(uuid, boolean, text) from public, anon, authenticated;
revoke all on function clear_old_report_text(int) from public, anon, authenticated;
revoke all on function admin_moderation_log(uuid, uuid) from public, anon, authenticated;
revoke all on function admin_report_state(uuid[]) from public, anon, authenticated;
grant execute on function admin_resolve_report(uuid, text, text) to authenticated, service_role;
grant execute on function admin_reopen_report(uuid, text) to authenticated, service_role;
grant execute on function admin_suspend(uuid, text) to authenticated, service_role;
grant execute on function admin_unsuspend(uuid, text) to authenticated, service_role;
grant execute on function admin_hide_message(uuid) to authenticated, service_role;
grant execute on function admin_set_legal_hold(uuid, boolean, text) to authenticated, service_role;
grant execute on function clear_old_report_text(int) to authenticated, service_role;
grant execute on function admin_moderation_log(uuid, uuid) to authenticated, service_role;
grant execute on function admin_report_state(uuid[]) to authenticated, service_role;
