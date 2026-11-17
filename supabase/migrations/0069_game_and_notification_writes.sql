-- S1 and S5 (M3 safety review, brought forward by the release audit, 17 Nov 2026).
-- These two corrections were planned inside M3's hardening migration; that migration must not repeat
-- them (docs/audit/fixes.md, "M3 numbering").
--
-- S1: an organiser could delete a game row directly through the API. The cascade removed its players,
-- chat and notices without telling anyone, bypassing set_match_status (cancel notices, "cancel is
-- final"). Cancelling stays the only way to end a game; admin clean-up, if ever needed, goes through
-- the service role. No web or app code deletes from matches.
--
-- S5: signed-in users held UPDATE on every column of notifications, so a user could rewrite a notice's
-- text and clear emailed_at / email_claimed_at to put it back in the email queue. After this, the only
-- column a user can change is read_at (the policy "notifications: own mark read" still limits it to
-- their own rows). The web marks notices read through mark_notifications_read (security definer).
--
-- Safe to re-run.
drop policy if exists "matches: organizer delete" on matches;
revoke delete on matches from anon, authenticated;

revoke update on notifications from anon, authenticated;
grant update (read_at) on notifications to authenticated;
