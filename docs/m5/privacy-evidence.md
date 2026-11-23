# M5 — evidence behind the privacy policy and terms

Branch `m5-store-readiness` (from `integration/launch-1` `3ac77ff`, 23 Nov 2026). Every unmarked statement on `/privacy`,
`/terms` and `/delete-account` is listed here with the code that makes it true. Items still marked on the pages
(`Pending`: decision, legal review, proposed wording) are listed at the end. If the code changes, update this file and
the page together; `src/app/legal.test.tsx` checks the statements of absence against the code.

## What is collected

| Statement | Evidence |
| --- | --- |
| Sign-in by emailed code, Google, Apple (iPhone) | `src/app/login/LoginForm.tsx` (`signInWithOtp`, `signInWithOAuth` google); `mobile/app/sign-in.tsx` (`signInWithOtp`, Google via `openAuthSessionAsync`, `signInWithIdToken` apple in `mobile/lib/appleAuth.ts`). Password sign-in exists only in the **Staging** app (`StagingPasswordSignIn`, `installedVariant === "staging"`). |
| Sign-in service keeps what Google/Apple send | Supabase Auth stores the provider's identity data (`auth.identities`, `raw_user_meta_data`); the app reads only the email and name. |
| Name, optional phone, sports, level, roles | `profiles` columns `name, phone, sports, level, roles` (`0001_init.sql` …); phone optional in `ProfileForm.tsx` and the app profile. |
| 18+ answer with time and channel; nothing else about age | `profiles.age_confirmed_at`, `age_confirmed_via` (`0080_age_18_plus.sql`, `confirm_age`); no date of birth column. |
| Community rules acceptance; email-alert preference; alerts not sent today | `profiles.rules_accepted_at` (0074), `profiles.email_notifications`; `/api/notify/email` needs `GMAIL_USER`/`GMAIL_APP_PASSWORD`, which are unset in every environment (Vercel inventory, 22 Nov). |
| Booking fields | `bookings` (club, court, start/end, `price_usd`, `fee_usd`, `status`, `source`, `created_by`, `client_token`). |
| Pay at the desk today; payment records hold amount, fee, status, provider reference | `clubs.payment_mode`; `payments` (`amount_usd, fee_usd, total_usd, status, provider, provider_ref`); provider is `simulated` (no real payments, master checklist P1–P9 deferred). |
| Games, join requests, participants, notes, chat | `matches`, `match_players`, `match_messages`; `match_hidden` (remove from own list). |
| Deleting own message removes it for everyone; a report keeps its copy | `delete_match_message` sets `body = ''`, `deleted_at` (0042); `reports.snapshot` (0074) cleared by the 180-day rule (0082). |
| Blocks, reports with a copy, feedback, moderation decisions and notes, suspensions | `player_blocks`, `reports` (`snapshot`, `note`; feedback via `send_feedback` inserts into `reports`), `moderation_log`, `account_suspensions` (0074, 0082). |
| Deletion request record | `account_deletions` (`requested_at, requested_via, status, …`) (0079). |
| Coach profile incl. WhatsApp shown to signed-in players | `coaches` (`bio, price_usd, whatsapp`); `coach_card`, `coaches_at_club` require a signed-in user. |
| Staff actions and club photos | `created_by` on `bookings`, `blocks`; `club_media.created_by`; uploads through `/api/club-media`. |
| Error reports: kind of error, place in our code, page/screen (address scrubbed), version, device type and OS; error text withheld unless a fixed message or a code; no name, account, email or network address | Website `src/lib/monitoring.ts` (allowlist). App `mobile/lib/crash.ts` (allowlist since M5 review: `scrubEvent`, `scrubBreadcrumb` at recording time, `safeText`, `safeUrl`; sessions and automatic native breadcrumbs off). **Verified on what Sentry received** (staging, 23 Nov, `docs/m5/crash-privacy.md`): no probe value in the app's reports. |
| App reports: Sentry derives country and city from the connection; no IP stored | Received app events carry `user.geo` (emulator run and a real iPhone report of 15 Nov); no `ip_address`. The website event checked has neither. Stopping it is a Sentry setting (**decision, not changed**). |
| Native crashes (phone's own code) carry an installation ID, language, time zone, device state and the system's error message, not filtered by the app | Received native crash `dbf941d9…` (staging, 23 Nov): `user.id` = `device.id` (installation ID), `device.locale`, `device.timezone`, memory, storage, battery, boot time, kernel, rooted flag, app permissions; exception text from the system. `beforeSend` does not run for these. Breadcrumbs in it were the filtered ones. (**decision:** native filter in a new build, or declare) |
| Hosting providers keep server records with IP addresses | Standard Vercel and Supabase request logs (provider-side; retention set by the provider). |
| App keeps sign-in in secure storage; website in cookies; filters in the browser | `mobile/lib/secureStorage.ts` (expo-secure-store); `@supabase/ssr` cookies; `src/lib/prefs.ts` (`localStorage` key `cb_prefs`: area and sport). |

## What is not done

| Statement | Evidence (and the test that keeps it true) |
| --- | --- |
| No location | No location library in `package.json` or `mobile/package.json`; no `geolocation` call in `src` (the security header only *allows* the site to ask: `next.config.ts`). Test: `legal.test.tsx`. |
| App asks for no contacts, photos, camera, microphone | `mobile/app.json`: no `android.permissions`, no iOS `*UsageDescription`; `check-native-config.sh`: the app declares only INTERNET and VIBRATE; Face ID text removed. Test: `legal.test.tsx`. |
| No advertising, analytics or tracking; nothing sold | No such library in either `package.json` (test: `legal.test.tsx`); fonts are bundled (`@fontsource-variable/inter`), no third-party scripts. |

## Who sees what

| Statement | Evidence |
| --- | --- |
| Organiser name, game details, joined count visible to signed-in players | `match_board`, `open_matches`, `match_detail` return `organizer_name`, counts, level, note. |
| Only players in a game see each other's names and the chat | `mobile/lib/gameScreens.ts` (`showsNames`: "Only players in the game see who is playing"); `match_messages: members read` = `is_match_member(match_id)` and not blocked by the reader. |
| Players never see another's email or phone | `profiles` readable only by its owner or an admin (`profiles: read own`); no function returns another player's phone or email to a player. |
| Club staff see name and phone for bookings at their club | `bookings: read` = `player_id = auth.uid() OR is_staff_of(club_id)`; the player's name and phone reach staff only through that club's desk views. |
| Anyone sees free/busy, not who | `public_occupancy` view: club, court, times, kind only. |
| Providers: Supabase (Frankfurt), Vercel (Frankfurt), Google, Apple, Sentry, Expo | Live project `lgujfbwunokobjxlvpuf` eu-central-1; `vercel.json` `regions: ["fra1"]`; sign-in email through Gmail SMTP; Sign in with Apple; Sentry DSN for website and apps; expo-updates. **Sentry's data region is not recorded anywhere — to confirm (decision list).** |

## How long

| Statement | Evidence |
| --- | --- |
| Kept while the account exists | No retention job on profiles, bookings, games or chat. |
| Unpaid hold expires after a few minutes | `bookings.hold_expires_at`, club `hold_minutes`. |
| Report text (`reports.snapshot`, `reports.note`) is **due** for clearing 180 days after `closed_at`; never while `status = 'open'` or `legal_hold`; the row stays | `enforce_report_retention` (0082): `status <> 'open' and not legal_hold and closed_at < now() - 180 days`. |
| Moderation-log notes are cleared 180 days after the entry's own `at` (not the report's closing); kept while its report is open or on legal hold, and for `suspend`/`unsuspend` entries while an `account_suspensions` row exists for that profile | Same function, second `update` (0082). |
| **Clearing is not continuous.** It runs only when (a) any player files a report (statement trigger `reports_enforce_retention`), (b) an admin opens Admin → Reports (`clear_old_report_text`, `src/app/admin/reports/page.tsx`), or (c) an admin presses the clear button. With no reports and no admin visits, eligible text stays. | No scheduler exists (no pg_cron job, no scheduled workflow). M5 adds none (review, 23 Nov). The privacy page says "due to be cleared … can stay for some time after" and marks the latest-date promise as a pending decision. |
| Deletion as described on `/delete-account` | `delete_account_data`, `finish_account_deletion` (0079); 102 checks + race tests (`supabase/tests/m2`). |

## Terms

| Rule | Evidence |
| --- | --- |
| 18+, asked before booking, games, chat | `/age` gate (`src/lib/playerGate.ts`), app `AgeGate.tsx`; database refusal behind `require_age_confirmation` (OFF until approved). |
| A court cannot be booked twice | Exclusion constraint on `bookings` (court + time range) and booking-over-block trigger. |
| Club sets hours, window, min/max length, max upcoming bookings, cancellation cutoff | `clubs.open_time/close_time, booking_window_days, min/max_booking_minutes, max_upcoming_bookings, cancel_cutoff_hours`. |
| Player can cancel until the start; then only the club | `cancel_booking` (0083 `booking_started`); staff `move_booking`/`cancel_booking`. Verified on staging: `cancel` 30/30. |
| Club can record a no-show; club can cancel | `mark_no_show`; staff `cancel_booking` (refund due when club-caused). |
| Pay at the desk today | `clubs.payment_mode`; no real payment provider (P1–P9 deferred). |
| Community rules shown verbatim | `COMMUNITY_RULES` in `src/lib/types.ts` (and `mobile/lib/safety.ts`); test compares them. |
| Report, block; hide message; suspension stops posting, joining, organising, messaging | `report_content`, `block_player`, `admin_hide_message`, `admin_suspend`, `assert_active` (`account_suspended`). Verified on staging: `web_accept` M0–M11. |
| Lessons arranged directly with the coach | No coach booking function; coach pages show the coach's chosen contact. |

## Still marked on the pages

| Page | Item | Kind |
| --- | --- | --- |
| privacy, terms | Operator name and postal address | decision (L1) |
| terms | Governing law and courts | decision (L1) |
| terms | "By creating an account or using CourtBook, you agree" | legal |
| privacy | Card details handled by the payment provider (future) | proposed (payments phase) |
| privacy | Installation identifier and device details in native crash reports (confirmed present, 23 Nov) | decision: remove in a new app version before live crash reporting, or declare |
| privacy | Approximate location (country, city) Sentry derives for app reports | decision: Sentry setting (production monitoring, needs approval), or declare |
| privacy | Provider list, locations, transfers outside Lebanon | legal |
| privacy | Disclosure to authorities | legal |
| privacy, delete-account | Retention of anonymised bookings and payments; server record retention; "within 30 days" | legal (L6, M2b) |
| privacy | Rights under Lebanese law (Law 81/2018) and response time | legal |
| privacy | Under-18 accounts are closed | proposed |
| privacy, terms | Notice of changes in the app | proposed |
| terms | No-show limits | proposed (not implemented) |
| terms | In-app payment, fee and refund terms | decision (payments phase) |
| terms | Report review time | decision (moderator routine) |
| terms | Liability wording | legal |
