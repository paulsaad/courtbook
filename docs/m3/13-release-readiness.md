# M3 — release readiness (updated 20 Nov 2026, `m3-dev`)

M3 = Find a game, game screen, joining and organiser actions, Post / Edit a game, chat, Activity, player
safety (report, block, rules, suspension, moderation) and Help & Feedback. Everything below is on
**staging only**; live, `main`, the production website and the live apps are unchanged.

## Complete

| Area | State |
| --- | --- |
| Database (staging) | 0067, 0072, 0073, 0074, 0075 applied, each with a read-only check before and after (all passed). Rollback scripts exist for each. |
| Android staging app | Update `01a1f9c8…` (group `8384db5f…`). **Device check: PASS** (game and chat; block asks first, hides messages; unblock restores them). |
| iPhone staging app | Update `01a1fa3f…` (group `e1397c4b…`). **Device check: PASS** (update installed; game and chat; rules shown; send without duplicates or keyboard overlap; report; block; unblock). |
| Help & Feedback | **PASS** (app problem from Android → Admin → Reports → handled). |
| Reporting, blocking, moderation | **Verified on staging**: reports reach Admin → Reports (admins only; a player is refused), handled / dismissed, blocks hide messages and are undone in Profile, suspension and moderator history functions in place. Staging moderator `02111629`. |
| Community rules | Revised wording **approved** (20 Nov) and in the single shared copy for website and app; the rules sheet no longer mentions the terms of use. The new wording reaches phones only with the next approved app update. |
| Website (`m3-dev` preview, on staging) | Admin → Reports, chat with the rules prompt and hidden blocked senders, sentences for every new refusal. |
| Automated checks | Database suites (381 + M3 suites with deliberate-fault checks), website 147, app 538, emulator runs on staging. |
| Staging clean-up | Shared test game removed by its exact id (run 44799369520). The reports made during the checks stay, with their evidence, as designed. |

## Still necessary before public release

1. **Staging website check** of the `m3-dev` preview, because merging deploys the production website.
2. **Live database:** 0067 → 0072 → 0073 → 0074 → 0075, each preflight, apply, postcheck; live
   moderator account confirmed before 0074. Each needs its own approval.
3. **Turn game features on for live:** today game actions and chat run only against staging
   (`gameWritesFor`). A small code change after step 2, then live app updates (fingerprint-checked).
4. **Merge `m3-dev` → `main`** (production website) after steps 1–2.
5. **Store requirements:** moderator and review frequency named; report evidence cleared after 180 days
   (hold for serious cases) — not built; objectionable-content filter decision (word list empty by
   decision); final privacy policy and terms (operator, lawyer) — then the rules can link to them;
   independent VoiceOver / TalkBack check.

## Not required for release

Push and email (delivery milestone; in-app notices only, as decided) · email to the moderator per report
· admin removing a player from a game · chat design review · duplicate staging account `966f79cf`.
