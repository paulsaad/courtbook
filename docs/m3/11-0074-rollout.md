# M3 — 11. 0074 staging rollout (chat and player safety)

Staging only. Each numbered step needs Paul's approval; stop at the first failure.

## Why the order is safe

- **The installed Android staging app** (update from `9148605`, group `15f59966…`) has no chat screen and never
  writes messages. Its game calls keep their signatures under 0074; the two new refusals it can meet
  (`blocked`, `account_suspended`) already have sentences in it. 0074 cannot break it.
- **The next Android staging update** (`m3-dev`) decides at run time whether the database has 0074
  (`my_account_status` exists only with it). Before 0074: no Report / Block / Help options, chat as today.
  After 0074: they appear by themselves, within 5 minutes or when the app restarts. After a rollback of
  0074: they disappear again. The rules sheet opens whenever the server asks (`rules_not_accepted`), so
  chat cannot get stuck in either state. JS only: no native file changed since `9148605`.
- **The staging website** (`m3-dev` preview) already handles the rules, blocked senders and Admin → Reports
  (which says "not available on this database yet" before 0074).

## Sequence

| # | Step | Action | Pass when |
| --- | --- | --- | --- |
| 1 | Make the staging moderator | Staging database → `m3_moderator_grant`, accounts = the 8-character id (`m3_accounts`) | prints `after: … roles player,admin` |
| 2 | Check the moderator (read only) | `m3_moderator_check` | `is_admin() as them: true`; Reports "needs 0074" |
| 3 | Android staging update | Mobile update → publish, app staging, platform android, from `m3-dev` | checks and fingerprint pass; Paul's phone shows the new update ID in Profile → About; posting and chat work; Help & Feedback shows the contact address only |
| 4 | 0074 preflight (read only) | `m3_0074_preflight` | every part-1 row true |
| 5 | Apply 0074 | `apply`, migrations `0074`, confirm_ref `pwznauyioqykdwodwpvx` | "applied 1 migration(s)" |
| 6 | 0074 postcheck (read only) | `m3_0074_postcheck` | every row true |
| 7 | Moderator check again | `m3_moderator_check` | admin_reports answers for the moderator; a player is refused (`forbidden`) |
| 8 | Phone and website | Close and reopen the app | first chat message asks for the five rules once; Report / Block on messages and games; Help & Feedback: problem, suggestion, report a player; Admin → Reports on the preview shows them; Mark handled / Dismiss work |

## Undo

- 0074: `supabase/live/0074_rollback.sql` (staging SQL editor; refuses unless the 0074 functions are present).
  The safety controls disappear from the updated app by themselves; blocks, reports and suspensions stay
  stored, unused. Roll back 0074 before 0073.
- Android update: Mobile update → rollback-to-previous, group `15f59966-05e1-4644-a18c-3e2bcef2634a`.

## Monitoring reports during the pilot (no email yet)

- **Where:** website Admin → Reports (admin home shows "Reports (N open)"). Player reports first, then
  app problems and suggestions. Everything is visible to admins only.
- **Who:** the moderator account(s) with the admin role (Paul during the pilot).
- **How often:** Paul's choice. Nothing promises players a response time; blocking works instantly without
  the moderator.
- **Serious incidents** (threats, sexual content, anything involving a minor, private details, danger):
  suspend at once, keep the evidence (the report keeps the message as it was), record what was done.
- **Not built:** report email (delivery milestone), clearing evidence after 180 days (before store
  submission), an admin removing a player from a game.
