-- ROLLBACK of chat_notices_without_text.draft.sql (DRAFT, not applied). Restores the two functions exactly as before
-- (match_message_notify from 0074, claim_notifications_to_email from 0026): new chat notices would carry the message
-- excerpt again, and emails would send it.
-- It CANNOT restore the excerpts the draft discarded from existing notices: by design they are kept nowhere. Those rows
-- stay "New message from <name>". Nothing else was changed, so nothing else needs restoring.

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
      insert into notifications (profile_id, kind, match_id, actor_id, body) values (r.pid, 'match_message', new.match_id, new.profile_id, who || ': ' || left(new.body, 80));
    end if;
  end loop;
  return new;
end $$;

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
  select n.id, u.email::text, p.name, n.body, n.kind, n.match_id
  from claimed c join notifications n on n.id = c.id join profiles p on p.id = n.profile_id join auth.users u on u.id = p.id
  where u.email is not null;
$$;
revoke execute on function claim_notifications_to_email(int) from public, anon, authenticated;
grant execute on function claim_notifications_to_email(int) to service_role;
