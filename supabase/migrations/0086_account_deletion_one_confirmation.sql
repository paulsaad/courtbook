-- 0086 — Account deletion with one confirmation (M2 redesign; proposal "account deletion: one-confirmation flow", revision 2,
-- approved 23 Nov 2026). Replaces request-and-wait.
--
-- The player confirms once; the account closes at once and the server finishes the deletion in the background.
--   A  close            close_my_account() (the player) / admin_record_deletion_request() (support): one record, status
--                       'closing' — or 'held' (legal hold, coach bookings, suspended: kept until released). From this
--                       commit the account can write nothing at all (closed_account_lockout on every table, assert_active).
--   B  ban sign-in      server (Supabase Auth, service key) → record_deletion_step('banned'): status 'closed'.
--   C  data step        delete_account_data(): 0079's tested step, unchanged except: the new states; held accounts only in
--                       cancel-only mode (cancel upcoming bookings and games, leave others' games; nothing anonymised
--                       or deleted); the first full run moves any closed state to 'data_removed'.
--   D  delete sign-in   server (Supabase Auth). profiles_delete_guard (0079) refuses it before C.
--   E  finish           finish_account_deletion() → 'done'; now idempotent.
-- Every step can be repeated. A run first claims the record (claim_deletion: a lease and a token, `for update skip
-- locked`); bookkeeping writes need the current token, so a run whose lease was taken over cannot record anything.
-- Failures are recorded as a code only and retried with backoff (deletions_due); records needing a person are listed by
-- deletions_needing_attention. The server functions run with the service key only (auth.uid() is null).
-- Not changed: 0079's data step logic, its locking order, refusals, insert guards and profiles_delete_guard.

-- ============ 1. states and progress (no personal data) ============
alter table account_deletions drop constraint if exists account_deletions_status_check;
alter table account_deletions add constraint account_deletions_status_check
  check (status in ('requested', 'cancelled', 'closing', 'closed', 'held', 'data_removed', 'done'));
alter table account_deletions
  add column if not exists closing_at timestamptz,
  add column if not exists banned_at timestamptz,
  add column if not exists held_reason text,
  add column if not exists cancellations_at timestamptz,
  add column if not exists attempts int not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_until timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists last_error text,
  add column if not exists alerted_at timestamptz;
alter table account_deletions drop constraint if exists account_deletions_held_reason_check;
alter table account_deletions add constraint account_deletions_held_reason_check
  check ((held_reason is null or held_reason in ('legal_hold', 'coach_has_bookings', 'suspended')) and (status <> 'held' or held_reason is not null));
-- an error is a code, never text that could be about the person
alter table account_deletions drop constraint if exists account_deletions_last_error_check;
alter table account_deletions add constraint account_deletions_last_error_check check (last_error is null or last_error ~ '^[a-z_]{1,60}$');
drop index if exists account_deletions_one_open;
create unique index account_deletions_one_open on account_deletions (subject_id) where status in ('requested', 'closing', 'closed', 'held', 'data_removed');
create index if not exists account_deletions_due on account_deletions (next_attempt_at) where status in ('closing', 'closed', 'held', 'data_removed');
-- open requests of the old flow become closures (staging had none open on 23 Nov: deletion_state; live has no 0079)
update account_deletions set status = 'closing', closing_at = coalesce(closing_at, requested_at), next_attempt_at = coalesce(next_attempt_at, now())
 where status = 'requested';

-- ============ 2. a closed account writes nothing ============
create or replace function deletion_requested(p_profile uuid) returns boolean
language sql stable security definer set search_path = public as $$
  -- every open state: closing, closed (banned), held, data removed (sign-in deletion still to come), and the old 'requested'
  select p_profile is not null and exists (select 1 from account_deletions where subject_id = p_profile and status in ('requested', 'closing', 'closed', 'held', 'data_removed'));
$$;
revoke all on function deletion_requested(uuid) from public, anon, authenticated;
grant execute on function deletion_requested(uuid) to service_role;

create or replace function assert_active() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if exists (select 1 from account_suspensions where profile_id = auth.uid()) then raise exception 'account_suspended'; end if;
  if deletion_requested(auth.uid()) then raise exception 'account_closed'; end if;   -- 0086
end $$;
revoke all on function assert_active() from public, anon, authenticated;

-- One statement-level guard on every table: a signed-in person whose account is closed changes nothing, whatever the
-- path (a function, a direct write, a trigger in their transaction). The deletion itself runs with the service key
-- (no signed-in person) and other people's actions are unaffected. A new table must get it too (tested: E1).
create or replace function refuse_writes_by_closed_account() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if deletion_requested(auth.uid()) then raise exception 'account_closed'; end if;
  return null;
end $$;
revoke all on function refuse_writes_by_closed_account() from public, anon, authenticated;
do $$
declare t text;
begin
  for t in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'account_deletions' loop
    execute format('drop trigger if exists closed_account_lockout on %I', t);
    execute format('create trigger closed_account_lockout before insert or update or delete on %I for each statement execute function refuse_writes_by_closed_account()', t);
  end loop;
end $$;

-- ============ 3. A: close (one confirmation) ============
create or replace function close_account_internal(p_subject uuid, p_via text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype; refusal text; hold text;
begin
  if p_via is null or p_via not in ('app', 'web', 'support') then raise exception 'invalid_via'; end if;
  -- waits for this person's writes still in flight (each holds a key-share lock on the profile row until it commits)
  -- and for a second close of the same account; afterwards the lock-out refuses anything new
  perform 1 from profiles where id = p_subject for update;
  if not found then raise exception 'not_found'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('requested', 'closing', 'closed', 'held', 'data_removed');
  if found then   -- already closed: the same record, nothing new (a second tap, a second device)
    return jsonb_build_object('status', d.status, 'held_reason', d.held_reason, 'closed_at', d.closing_at, 'new', false);
  end if;
  refusal := deletion_refusal(p_subject);
  if refusal in ('admin_role', 'staff_role') then raise exception '%', refusal; end if;   -- support removes the role first
  hold := coalesce(refusal, case when exists (select 1 from account_suspensions where profile_id = p_subject) then 'suspended' end);
  insert into account_deletions (subject_id, requested_via, status, closing_at, held_reason, next_attempt_at)
  values (p_subject, p_via, case when hold is null then 'closing' else 'held' end, now(), hold, now())
  returning * into d;
  return jsonb_build_object('status', d.status, 'held_reason', d.held_reason, 'closed_at', d.closing_at, 'new', true);
end $$;
revoke all on function close_account_internal(uuid, text) from public, anon, authenticated, service_role;

create or replace function close_my_account(p_via text default 'app') returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if p_via is null or p_via not in ('app', 'web') then raise exception 'invalid_via'; end if;
  return close_account_internal(auth.uid(), p_via);
end $$;
revoke all on function close_my_account(text) from public, anon, authenticated;
grant execute on function close_my_account(text) to authenticated;

-- a request received by email to support (identity checked by the admin): closes the same way
create or replace function admin_record_deletion_request(p_subject uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  perform close_account_internal(p_subject, 'support');
end $$;
revoke all on function admin_record_deletion_request(uuid) from public, anon, authenticated;
grant execute on function admin_record_deletion_request(uuid) to authenticated, service_role;

-- D1: no undo, and no request-and-wait any more
revoke execute on function request_account_deletion(text) from authenticated;
revoke execute on function cancel_account_deletion() from authenticated;

create or replace function my_account_deletion() returns jsonb
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null else
    (select jsonb_build_object('status', status, 'requested_at', requested_at, 'closed', status <> 'requested')
       from account_deletions where subject_id = auth.uid() and status in ('requested', 'closing', 'closed', 'held', 'data_removed')) end;
$$;
revoke all on function my_account_deletion() from public, anon, authenticated;
grant execute on function my_account_deletion() to authenticated, service_role;

-- ============ 4. C: the data step (0079, see the header for the only changes) ============
drop function if exists delete_account_data(uuid);
create or replace function delete_account_data(p_subject uuid, p_cancel_only boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d account_deletions%rowtype;
  refusal text;
  r record;
  n_games int := 0; n_cancelled int := 0; n_refund int := 0; n_anon int; n_msgs int; n_left int; n_notes int;
  v_name text;
  susp jsonb;
  v_cutoff int;
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if p_subject is null then raise exception 'not_found'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('requested', 'closing', 'closed', 'held', 'data_removed') for update;
  if not found then raise exception 'no_open_request'; end if;
  if d.status = 'held' and not p_cancel_only then raise exception 'held: %', d.held_reason; end if;   -- 0086: held accounts keep their data
  if p_cancel_only and d.status <> 'held' then raise exception 'not_held'; end if;
  -- Re-running after the data step is allowed and repeats it: every step only touches what is still there, so a
  -- second run changes nothing — unless something arrived in between (a hold that was being written while the first
  -- run ran), which it then cancels and anonymises too. The first run's counts are kept; a re-run is recorded.
  refusal := deletion_refusal(p_subject);
  if refusal is not null and not (p_cancel_only and refusal in ('legal_hold', 'coach_has_bookings')) then raise exception '%', refusal; end if;

  -- Lock order, same as every other path: courts (sorted, as lock_courts does for move_booking and the desk), then
  -- games, then bookings, then payments. cancel_booking and the booking→game trigger take courts → booking → game,
  -- so taking every court first leaves no cycle with them.
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending')
       and (b.player_id = p_subject or b.id in (select m.booking_id from matches m where m.organizer_id = p_subject))), '{}'));
  -- Wait for any booking, game or message for this person still being written by another transaction: each holds a
  -- key-share lock on the profile row (foreign-key check) until it commits, and FOR UPDATE waits for it. New ones are
  -- refused by the insert guards, since the request is open. Then lock any court that only now appears (a hold placed
  -- on a court none of their bookings used): the cancellation loop below sees and cancels it.
  perform 1 from profiles where id = p_subject for update;
  perform lock_courts(coalesce((select array_agg(distinct b.court_id) from bookings b
     where b.court_id is not null and b.status in ('confirmed', 'pending') and b.player_id = p_subject), '{}'));
  select name into v_name from profiles where id = p_subject;

  -- (a) upcoming games they organise: cancelled, players told (before the bookings, so no "court lost" notices)
  for r in select * from matches where organizer_id = p_subject and status <> 'cancelled'
             and coalesce(end_at, start_at + interval '3 hours') > now() for update loop
    update matches set status = 'cancelled', closed_at = now(), closed_reason = null where id = r.id;
    insert into notifications (profile_id, kind, match_id, body)
    select mp.profile_id, 'match_cancelled', r.id, 'Match cancelled: the organizer closed their account'
      from match_players mp where mp.match_id = r.id and mp.status in ('accepted', 'pending') and mp.profile_id <> p_subject;
    n_games := n_games + 1;
  end loop;

  -- (b) their future and pending bookings: cancelled under the same rules as cancel_booking (player side):
  --     pending → payment expired; paid and before the club's cutoff → refund due; inside the cutoff → no refund.
  --     Lock order as cancel_booking: court, then booking, then payments. Legacy credits are not re-issued.
  for r in select b.id, b.court_id, b.club_id from bookings b
             where b.player_id = p_subject
               and (b.status = 'pending' or (b.status = 'confirmed' and b.start_at > now()))  -- every hold, even a stale one
             order by b.start_at loop
    perform 1 from bookings where id = r.id for update;
    perform 1 from payments where booking_id = r.id for update;
    select cancel_cutoff_hours into v_cutoff from clubs where id = r.club_id;
    if (select status from bookings where id = r.id) = 'pending' then
      update payments set status = 'expired' where booking_id = r.id and status = 'pending';
    elsif (select start_at from bookings where id = r.id) - make_interval(hours => v_cutoff) > now() then
      update payments set status = 'refund_due', note = 'cancelled before cutoff (account deleted)'
       where booking_id = r.id and status = 'paid';
      get diagnostics n_left = row_count; n_refund := n_refund + n_left;
    end if;
    update bookings set status = 'cancelled', cancelled_at = now() where id = r.id;
    n_cancelled := n_cancelled + 1;
  end loop;

  if not p_cancel_only then   -- 0086: (c)–(e) only when the data is really to be removed
  -- (c) every booking of theirs stays as the club's and accounting record, anonymised
  update bookings set player_id = null, guest_name = 'Former player', guest_phone = null where player_id = p_subject;
  get diagnostics n_anon = row_count;

  -- (d) chat messages deleted (a report keeps its snapshot); out of every game's player list
  delete from match_messages where profile_id = p_subject;
  get diagnostics n_msgs = row_count;
  end if;
  -- leaving upcoming games of others as leave_match does: organiser told, a game closed only because it was full reopens
  for r in select m.*, mp.status as was from match_players mp join matches m on m.id = mp.match_id
             where mp.profile_id = p_subject and m.status <> 'cancelled' and m.start_at > now() for update of m loop
    delete from match_players where match_id = r.id and profile_id = p_subject;
    if r.was = 'accepted' then
      insert into notifications (profile_id, kind, match_id, body)
      select r.organizer_id, 'player_left', r.id, 'A player left your match' where r.organizer_id is not null;
      if r.status = 'closed' and r.closed_reason = 'full'
         and (select count(*) from match_players where match_id = r.id and status = 'accepted') < r.players_needed then
        update matches set status = 'open', closed_at = null, closed_reason = null where id = r.id;
      end if;
    end if;
  end loop;
  if p_cancel_only then     -- 0086 held account: record what was cancelled; status stays held, data kept
    update account_deletions set cancellations_at = coalesce(cancellations_at, now()),
      summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('held_cancellations', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund))
     where id = d.id returning summary into susp;
    return susp;
  end if;
  delete from match_players where profile_id = p_subject;              -- past games: off the list too

  -- (d2) what others hold about them: chat excerpts in others' notifications go; their name in other notices becomes
  --      "A player"; notes on games they organised (free text: could hold a phone number) are cleared; their own
  --      Help & Feedback messages go (support, not moderation). Moderation reports and snapshots stay (evidence).
  delete from notifications where actor_id = p_subject and kind = 'match_message';
  if coalesce(btrim(v_name), '') <> '' then
    update notifications set body = regexp_replace(body, '\m' || regexp_replace(v_name, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g') || '\M', 'A player', 'g')
     where actor_id = p_subject or body like '%' || v_name || '%' and match_id in (select id from matches where organizer_id = p_subject);
  end if;
  update matches set note = null where organizer_id = p_subject and note is not null;
  get diagnostics n_notes = row_count;
  delete from reports where reporter_id = p_subject and target_kind = 'feedback';

  -- (e) coach listing (no coach bookings, checked above); profile anonymised now in case the sign-in deletion is late
  delete from coaches where profile_id = p_subject;
  -- only the date: the reason is free text written about the person; it is kept (with its retention rule) in the
  -- moderation records, not in this permanent deletion record
  select jsonb_build_object('suspended_at', suspended_at) into susp from account_suspensions where profile_id = p_subject;
  update profiles set name = null, phone = null, level = null, sports = '{}', email_notifications = false where id = p_subject;

  if d.status in ('requested', 'closing', 'closed') then
    update account_deletions set status = 'data_removed', data_removed_at = now(), processed_by = auth.uid(),
      summary = jsonb_build_object('games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'refunds_due', n_refund,
                                   'bookings_anonymised', n_anon, 'messages_deleted', n_msgs, 'game_notes_cleared', n_notes, 'suspension', susp)
     where id = d.id returning summary into susp;
  else
    update account_deletions set summary = summary || jsonb_build_object('last_rerun', jsonb_build_object('at', now(),
        'games_cancelled', n_games, 'bookings_cancelled', n_cancelled, 'bookings_anonymised', n_anon, 'messages_deleted', n_msgs))
     where id = d.id returning summary into susp;
  end if;
  return susp;
end $$;
revoke all on function delete_account_data(uuid, boolean) from public, anon, authenticated;
grant execute on function delete_account_data(uuid, boolean) to authenticated, service_role;   -- admin or service only (checked inside)

-- ============ 5. E: finish, now idempotent ============
create or replace function finish_account_deletion(p_subject uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  if exists (select 1 from profiles where id = p_subject) then raise exception 'account_still_exists'; end if;
  update account_deletions set status = 'done', done_at = now(), lease_until = null, lease_token = null, last_error = null, next_attempt_at = null
   where subject_id = p_subject and status = 'data_removed';
  if not found then
    if exists (select 1 from account_deletions where subject_id = p_subject and status = 'done') then return; end if;   -- already finished
    raise exception 'no_removed_request';
  end if;
end $$;
revoke all on function finish_account_deletion(uuid) from public, anon, authenticated;
grant execute on function finish_account_deletion(uuid) to authenticated, service_role;

-- ============ 6. running it: lease, steps, retries, attention (service key only) ============
create or replace function deletion_backoff(p_attempts int) returns interval
language sql immutable as $$
  select case when p_attempts <= 1 then interval '1 minute' when p_attempts = 2 then interval '5 minutes'
              when p_attempts = 3 then interval '15 minutes' when p_attempts = 4 then interval '1 hour' else interval '6 hours' end;
$$;

-- Claims a record for one run. Returns {claimed:false, reason} when another run holds it ('busy' = locked right now,
-- 'leased' = lease not expired), when it needs nothing ('held' with its work done; 'done'; 'cancelled'; 'none').
create or replace function claim_deletion(p_subject uuid, p_lease_seconds int default 300) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype; v_token uuid := gen_random_uuid(); s text;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then raise exception 'invalid_lease'; end if;
  select * into d from account_deletions where subject_id = p_subject and status in ('closing', 'closed', 'held', 'data_removed')
     for update skip locked;
  if not found then
    if exists (select 1 from account_deletions where subject_id = p_subject and status in ('closing', 'closed', 'held', 'data_removed')) then
      return jsonb_build_object('claimed', false, 'reason', 'busy');
    end if;
    select status into s from account_deletions where subject_id = p_subject order by requested_at desc limit 1;
    return jsonb_build_object('claimed', false, 'reason', coalesce(s, 'none'));
  end if;
  if d.lease_until is not null and d.lease_until > now() then return jsonb_build_object('claimed', false, 'reason', 'leased'); end if;
  if d.status = 'held' and d.banned_at is not null and d.cancellations_at is not null then
    return jsonb_build_object('claimed', false, 'reason', 'held');
  end if;
  update account_deletions set lease_until = now() + make_interval(secs => p_lease_seconds), lease_token = v_token, attempts = attempts + 1
   where id = d.id;
  return jsonb_build_object('claimed', true, 'token', v_token, 'status', d.status, 'held_reason', d.held_reason,
    'banned', d.banned_at is not null, 'cancellations_done', d.cancellations_at is not null, 'attempts', d.attempts + 1);
end $$;

-- Bookkeeping for the run holding the token. A run whose lease was taken over gets 'lease_lost' and records nothing.
--   banned   — sign-in banned: 'closing' → 'closed'
--   failed   — a step failed: error code kept, next try after the backoff, lease released
--   released — the run ends without failure (a held record: done until released by an admin)
create or replace function record_deletion_step(p_subject uuid, p_token uuid, p_step text, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype;
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  select * into d from account_deletions where subject_id = p_subject and lease_token = p_token and p_token is not null
     and status in ('closing', 'closed', 'held', 'data_removed') for update;
  if not found then raise exception 'lease_lost'; end if;
  if p_step = 'banned' then
    update account_deletions set banned_at = coalesce(banned_at, now()), status = case when status = 'closing' then 'closed' else status end
     where id = d.id returning * into d;
  elsif p_step = 'failed' then
    if p_error is null or p_error !~ '^[a-z_]{1,60}$' then p_error := 'unknown_error'; end if;
    update account_deletions set last_error = p_error, next_attempt_at = now() + deletion_backoff(attempts), lease_until = null, lease_token = null
     where id = d.id returning * into d;
  elsif p_step = 'released' then
    update account_deletions set lease_until = null, lease_token = null, last_error = null,
      next_attempt_at = case when status = 'held' then null else now() end
     where id = d.id returning * into d;
  else
    raise exception 'invalid_step';
  end if;
  return jsonb_build_object('status', d.status, 'attempts', d.attempts, 'next_attempt_at', d.next_attempt_at);
end $$;

-- What a retry run should pick up: due, not leased, with work left
create or replace function deletions_due(p_limit int default 20) returns setof uuid
language sql stable security definer set search_path = public as $$
  select subject_id from account_deletions
   where (status in ('closing', 'closed', 'data_removed') or (status = 'held' and (banned_at is null or cancellations_at is null)))
     and coalesce(next_attempt_at, '-infinity') <= now()
     and (lease_until is null or lease_until < now())
     and auth.uid() is null
   order by next_attempt_at nulls first
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

-- Records a person should look at (alert once each): newly held, or not finished after an hour or three runs
create or replace function deletions_needing_attention() returns table (subject_id uuid, reason text)
language sql stable security definer set search_path = public as $$
  select d.subject_id, case when d.status = 'held' then 'held' else 'stuck' end
    from account_deletions d
   where d.alerted_at is null and auth.uid() is null
     and (d.status = 'held'
          or (d.status in ('closing', 'closed', 'data_removed') and (d.closing_at < now() - interval '1 hour' or d.attempts >= 3)));
$$;
create or replace function mark_deletion_alerted(p_subject uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then raise exception 'forbidden'; end if;
  update account_deletions set alerted_at = now() where subject_id = p_subject and status in ('closing', 'closed', 'held', 'data_removed');
end $$;

-- An admin releases a held record once nothing holds it any more; the run then continues at C.
create or replace function release_held_deletion(p_subject uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d account_deletions%rowtype; refusal text;
begin
  if not (auth.uid() is null or is_admin()) then raise exception 'forbidden'; end if;
  select * into d from account_deletions where subject_id = p_subject and status = 'held' for update;
  if not found then raise exception 'not_held'; end if;
  refusal := deletion_refusal(p_subject);
  if refusal is not null then raise exception '%', refusal; end if;
  if exists (select 1 from account_suspensions where profile_id = p_subject) then raise exception 'suspended'; end if;   -- D3: legal review
  update account_deletions set status = case when banned_at is not null then 'closed' else 'closing' end, held_reason = null,
    next_attempt_at = now(), alerted_at = null
   where id = d.id returning * into d;
  return jsonb_build_object('status', d.status);
end $$;

revoke all on function deletion_backoff(int) from public, anon, authenticated;
revoke all on function claim_deletion(uuid, int) from public, anon, authenticated;
revoke all on function record_deletion_step(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function deletions_due(int) from public, anon, authenticated;
revoke all on function deletions_needing_attention() from public, anon, authenticated;
revoke all on function mark_deletion_alerted(uuid) from public, anon, authenticated;
revoke all on function release_held_deletion(uuid) from public, anon, authenticated;
grant execute on function claim_deletion(uuid, int), record_deletion_step(uuid, uuid, text, text), deletions_due(int),
  deletions_needing_attention(), mark_deletion_alerted(uuid) to service_role;
grant execute on function release_held_deletion(uuid) to authenticated, service_role;   -- admin (checked inside) or service

-- ============ 7. the admin list ============
-- admin_account_deletions keeps 0079's exact shape (migrations from 0041 on must re-apply in order), widened to the
-- new states; the progress columns are a second function.
create or replace function admin_account_deletions()
returns table (subject_id uuid, status text, requested_at timestamptz, requested_via text, name text, phone text,
               upcoming_bookings int, upcoming_games_organised int, open_reports_about int, refusal text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select d.subject_id, d.status, d.requested_at, d.requested_via, p.name, p.phone,
    (select count(*)::int from bookings b where b.player_id = d.subject_id and b.status in ('confirmed', 'pending') and b.start_at > now()),
    (select count(*)::int from matches m where m.organizer_id = d.subject_id and m.status <> 'cancelled' and m.start_at > now()),
    (select count(*)::int from reports r where r.status = 'open' and (r.profile_id = d.subject_id or (r.target_kind = 'player' and r.target_key = d.subject_id))),
    deletion_refusal(d.subject_id)
  from account_deletions d left join profiles p on p.id = d.subject_id
  where d.status in ('requested', 'closing', 'closed', 'held', 'data_removed')
  order by d.requested_at;
end $$;
revoke all on function admin_account_deletions() from public, anon, authenticated;
grant execute on function admin_account_deletions() to authenticated, service_role;

-- progress of each open record (codes and dates only)
create or replace function admin_deletion_progress()
returns table (subject_id uuid, status text, held_reason text, closing_at timestamptz, banned_at timestamptz, cancellations_at timestamptz,
               data_removed_at timestamptz, attempts int, last_error text, next_attempt_at timestamptz, leased boolean, alerted boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return query
  select d.subject_id, d.status, d.held_reason, d.closing_at, d.banned_at, d.cancellations_at, d.data_removed_at, d.attempts, d.last_error,
         d.next_attempt_at, coalesce(d.lease_until > now(), false), d.alerted_at is not null
    from account_deletions d
   where d.status in ('requested', 'closing', 'closed', 'held', 'data_removed')
   order by d.closing_at nulls last, d.requested_at;
end $$;
revoke all on function admin_deletion_progress() from public, anon, authenticated;
grant execute on function admin_deletion_progress() to authenticated, service_role;
