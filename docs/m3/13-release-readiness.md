# M3 — release readiness (20 Nov 2026, `m3-dev`)

M3 = Find a game, game screen, joining and organiser actions, Post / Edit a game, chat, Activity, player
safety (report, block, rules, suspension, moderation) and Help & Feedback. Everything below is on
**staging only**; live, `main`, the production website and the live apps are unchanged.

## Complete (staging)

| Area | State |
| --- | --- |
| Database | 0067, 0072, 0073, 0074, 0075 applied to staging, each with a read-only check before and after (all passed). Rollback scripts exist for each. |
| Android staging app | Update `01a1f9c8…` (group `8384db5f…`): board, game screen, join / ask / leave, accept / decline / remove, private / reopen / cancel, court-cancelled choices, Post (one game per tap, retry-safe), Edit, chat, Activity, report (message, game, player), block / unblock, community rules, suspension notice, Help & Feedback. Safety features switch on by themselves where the database has them. |
| Website (`m3-dev` preview, now on staging) | Admin → Reports (player reports, app problems and suggestions, hide message, suspend / lift, handled / dismissed, earlier reports and blocks received), chat with the rules prompt and hidden blocked senders, sentences for every new refusal. |
| Moderation | Staging moderator `02111629` (admin); only admins can read reports or evidence (checked: a player is refused). |
| Decisions | Blocking model, five community rules (approved wording), empty blocked-word list. |
| Automated checks | Database suites (381 + M3 suites with deliberate-fault checks), website 147, app 538, emulator runs on staging (game actions; post, edit, chat). |
| Paul's device checks | Help & Feedback end to end: PASS. |

## Still necessary before public release

1. **Android blocking check** on the staging app (Paul, pending).
2. **iOS:** an iOS staging update from `m3-dev` and the same phone checks on the iPhone. Nothing of M3 has
   run on iOS yet.
3. **Website staging regression** of the `m3-dev` website (game pages, chat, refusals, admin) before
   merging, because merging to `main` deploys the production website.
4. **Live database:** 0067, 0072, 0073, 0074, 0075 in order, each with its preflight, apply and postcheck,
   and a live moderator account confirmed — each needs its own approval.
5. **Switch game features on for live:** the app enables game actions and chat only for the staging
   database today (`gameWritesFor`). Live needs a small, deliberate code change after step 4, then a live
   app update (fingerprint-checked) or build.
6. **Merge `m3-dev` → `main`** (production website) after steps 3–4, in an order that never puts the new
   website in front of a database without its migrations.
7. **Store requirements** (Apple / Google user-generated content):
   - Moderator and review frequency named (no response time is promised to players).
   - Report evidence cleared after 180 days, with a hold for serious cases — not built.
   - Objectionable-content filter: the mechanism exists but the word list is empty by decision; decide
     before submission whether reports + moderation suffice or a short list is approved (the display-name
     check comes with it).
   - Privacy policy and terms finalised (operator and jurisdiction still open; lawyer review).
   - Independent VoiceOver / TalkBack check (decided earlier as a pre-submission step).

## Not required for release (later or optional)

- Push and email (delivery milestone); the first release uses in-app notices only, as decided.
- Email to the moderator for each new report.
- An admin removing a player from a game (organisers can; admins can suspend).
- The light design review of the chat screen listed in the UX spec.
- The duplicate staging account `966f79cf` (staging only; untouched).

## Recommended next step

After the Android blocking check: publish the iOS staging update and run the same short checks on the
iPhone. Then the website staging regression, followed by a written live rollout plan (steps 4–6) for
approval.
