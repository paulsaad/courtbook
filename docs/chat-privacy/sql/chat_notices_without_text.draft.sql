-- DRAFT (unnumbered; NOT applied anywhere). Chat privacy, Paul's decision of 26 Nov (H4):
-- chat-message text never goes into notifications or notification emails.
--
-- Before: match_message_notify (0074) copied "<name>: <first 80 characters>" into each recipient's notification; the
-- website and the app showed it in Activity and /api/notify/email sent it by email. Deleting or hiding the message did
-- not remove the copies.
-- After:
--   1. new chat notices say only "New message from <name>" (the trigger otherwise exactly as 0074: who is told, hidden
--      games, blocks, one unread notice per game);
--   2. the email claim never returns a chat notice's stored text, whatever it holds (defence in depth);
--   3. every existing chat notice is rewritten to "New message from <name>": the stored text is discarded, deleted
--      messages and grouped notices included. No matching against messages: every row of the kind is rewritten.
-- Unchanged: every other notification kind (its rows and its triggers); the moderation evidence (reports.snapshot,
-- admin-only through the admin_* functions; no role can read the table); push_text (0072), which never used the text.
-- Irreversible by design: the discarded excerpts are not kept anywhere. Rollback: chat_notices_without_text.down.draft.sql.

-- 1 -----------------------------------------------------------------------------------------------------------------
create or replace function match_message_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; who text;
begin
  select coalesce(name, 'A player') into who from profiles where id = new.profile_id;
  for r in
    select m.organizer_id as pid from matches m where m.id = new.match_id
    union
    select mp.profile_id from match_players mp where mp.match_id = new.match_id and mp.status = 'accepted'
  loop
    if r.pid <> new.profile_id
       and not exists (select 1 from match_hidden h where h.profile_id = r.pid and h.match_id = new.match_id)
       and not exists (select 1 from player_blocks pb where pb.blocker_id = r.pid and pb.blocked_id = new.profile_id)
       and not exists (
         select 1 from notifications n where n.profile_id = r.pid and n.match_id = new.match_id and n.kind = 'match_message' and n.read_at is null
       ) then
      -- never the message text (H4): the notice says who wrote, the game page shows what
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, 'New message from ' || who);
    end if;
  end loop;
  return new;
end $$;

-- 2 -----------------------------------------------------------------------------------------------------------------
create or replace function claim_notifications_to_email(p_limit int)
returns table (id uuid, email text, name text, body text, kind text, match_id uuid)
language sql security definer set search_path = public as $$
  with picked as (
    select n.id from notifications n join profiles p on p.id = n.profile_id
    where n.emailed_at is null and p.email_notifications
      and (n.email_claimed_at is null or n.email_claimed_at < now() - interval '5 min')
    order by n.created_at limit least(p_limit, 50)
    for update of n skip locked
  ),
  claimed as (
    update notifications n set email_claimed_at = now() from picked where n.id = picked.id returning n.id
  )
  select n.id, u.email::text, p.name,
         case when n.kind = 'match_message'   -- a chat notice's stored text is never emailed (H4)
              then 'New message from ' || coalesce((select a.name from profiles a where a.id = n.actor_id), 'A player')
              else n.body end,
         n.kind, n.match_id
  from claimed c join notifications n on n.id = c.id join profiles p on p.id = n.profile_id join auth.users u on u.id = p.id
  where u.email is not null;
$$;
revoke execute on function claim_notifications_to_email(int) from public, anon, authenticated;
grant execute on function claim_notifications_to_email(int) to service_role;

-- 3 -----------------------------------------------------------------------------------------------------------------
-- Every chat notice, whatever it holds now (an excerpt, a deleted message's excerpt, a grouped notice). Idempotent.
update notifications n
   set body = 'New message from ' || coalesce((select a.name from profiles a where a.id = n.actor_id), 'A player')
 where n.kind = 'match_message'
   and n.body is distinct from 'New message from ' || coalesce((select a.name from profiles a where a.id = n.actor_id), 'A player');
