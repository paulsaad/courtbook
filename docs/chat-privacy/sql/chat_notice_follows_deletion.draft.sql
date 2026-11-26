-- DRAFT (unnumbered; not applied anywhere). H4 from Session B's handover (26 Nov): a deleted chat message stayed in
-- other players' Activity. match_message_notify (0074) copies "<name>: <first 80 characters>" into each recipient's
-- notification; deleting the message (delete_match_message, 0042: the sender; admin_hide_message, 0074/0082: an
-- admin acting on a report) cleared the message but not the copies. The app and the website read the same rows.
--
-- Now every way a message's text is removed (all of them set deleted_at and clear body) also replaces that text in the
-- notifications made from it: "<name>: message deleted". A notification holds the excerpt of the first unread message
-- only, so it is matched by match, sender and excerpt. Two messages with the same first 80 characters: deleting either
-- clears the notice (it errs toward removing text, never toward keeping it).
--
-- Not reachable: emails already sent (/api/notify/email sends the same text). A notice not yet emailed goes out with
-- the replaced text.

create or replace function chat_notice_follows_deletion() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tail text;
begin
  if old.deleted_at is null and new.deleted_at is not null and coalesce(old.body, '') <> '' then
    v_tail := ': ' || left(old.body, 80);
    update notifications n
       set body = left(n.body, char_length(n.body) - char_length(v_tail)) || ': message deleted'
     where n.kind = 'match_message' and n.match_id = new.match_id and n.actor_id = new.profile_id
       and char_length(n.body) >= char_length(v_tail)
       and right(n.body, char_length(v_tail)) = v_tail;
  end if;
  return new;
end $$;
revoke all on function chat_notice_follows_deletion() from public, anon, authenticated;

drop trigger if exists match_messages_deleted_notice on match_messages;
create trigger match_messages_deleted_notice after update of deleted_at on match_messages
  for each row execute function chat_notice_follows_deletion();

-- Notices already holding the text of a message deleted before this ran. The text itself is gone from the message,
-- so a notice is matched the other way round: its excerpt is no longer the start of any live message by that sender
-- in that game, and the sender has deleted a message there. Its prefix becomes the sender's current name.
update notifications n
   set body = coalesce((select p.name from profiles p where p.id = n.actor_id), 'A player') || ': message deleted'
 where n.kind = 'match_message' and n.actor_id is not null
   and n.body not like '%: message deleted'
   and exists (select 1 from match_messages d where d.match_id = n.match_id and d.profile_id = n.actor_id and d.deleted_at is not null)
   and not exists (select 1 from match_messages m
                   where m.match_id = n.match_id and m.profile_id = n.actor_id and m.deleted_at is null and m.body <> ''
                     and char_length(n.body) >= char_length(left(m.body, 80)) + 2
                     and right(n.body, char_length(left(m.body, 80)) + 2) = ': ' || left(m.body, 80));
