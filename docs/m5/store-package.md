# M5 — App Store and Google Play readiness package (CourtBook)

Branch `m5-store-readiness`, 23 Nov 2026. Draft for review. Nothing submitted, no account changed, nothing published.
Requirements were checked against Apple's and Google's current pages on 23 Nov 2026 (sources at the end).
Every answer below was checked against the code (evidence: `docs/m5/privacy-evidence.md`).

Legend:
- **Ready**: can be entered as written.
- **Paul**: needs a decision.
- **Legal**: needs the lawyer.
- **Eng**: engineering work.
- **Account**: needs the developer accounts.

## 0. Status at a glance

| Item | Status |
| --- | --- |
| Privacy policy and terms pages (`/privacy`, `/terms`) | **Built on this branch**, draft-marked, not published. Final text: Paul (operator, address, law) + Legal |
| Account deletion: in-app path and web URL | **Ready.** Profile → Delete my account (app and website); public `/delete-account` (email route without the app). Two provisional phrases are now marked (M2b) |
| Links to the legal pages in the app and the website | **Built on this branch.** Sign-in screen, Profile, Help & Feedback, the 18+ question, the deletion page |
| Apple App Privacy answers (§2) | **Ready**, one item to confirm (installation ID in native crash reports) |
| Google Data safety answers (§3) | **Ready**, same item, plus "sharing with clubs" to confirm (Legal) |
| Age rating answers, both stores (§4) | **Ready** (18+ decided) |
| Permissions (§5) | **Ready**: nothing to declare beyond Sign in with Apple |
| Listing text (§6) | **Drafted**; app name and support URL: **Paul** |
| Screenshots and graphics (§7) | **Eng** after the store build exists; specifications below |
| Reviewer access (§8) | **Paul**: choose an option; the live app has no password sign-in |
| Sign in with Apple token revocation on deletion (§9 E1) | **Eng, blocked on Account** (needs the company's Sign in with Apple key) |
| Message filter word list (Apple 1.2) | **Paul**: the filter exists (0074) but its list is empty by design |
| Developer accounts, D-U-N-S, store records (§9) | **Account / Paul** |

## 1. URLs to enter in both stores

| Field | Value |
| --- | --- |
| Privacy policy URL | `https://<domain>/privacy` |
| Terms of use (Apple: licence agreement link, optional) | `https://<domain>/terms` |
| Account deletion URL (Google Data safety, required) | `https://<domain>/delete-account` |
| Support URL (Apple, required) | **Paul**: `https://<domain>/delete-account` is not a support page; proposed: a short `/support` page or the contact email page |
| Contact email (Google, required) | courtbook.contact@gmail.com |

`<domain>` is **Paul**: today the only public address is `courtbook-three.vercel.app`. The app links use one constant,
`mobile/lib/legal.ts` `WEBSITE_URL`; change it there when the domain is decided.

## 2. Apple — App Privacy ("nutrition label")

Tracking: **No** (no data used to track across other companies' apps or websites; no advertising identifier; no
data brokers).

| Apple data type | Collected | Linked to user | Purpose | Why (code) |
| --- | --- | --- | --- | --- |
| Contact Info → Name | Yes | Yes | App Functionality | profile name, shown to clubs and game partners |
| Contact Info → Email Address | Yes | Yes | App Functionality | sign-in |
| Contact Info → Phone Number | Yes (optional) | Yes | App Functionality | optional, for the club about a booking |
| User Content → Other User Content | Yes | Yes | App Functionality | game chat, game notes, reports (with a copy of the reported content) |
| User Content → Customer Support | Yes | Yes | App Functionality | "Report an app problem / Suggest an improvement" (`send_feedback`) |
| Identifiers → User ID | Yes | Yes | App Functionality | account ID |
| Identifiers → Device ID | **To confirm** | No | App Functionality | only if the native crash reporter attaches an installation ID (§9 E2). If it does, declare; if not, omit |
| Purchases → Purchase History | Yes | Yes | App Functionality | bookings with their prices (paid at the desk today) |
| Diagnostics → Crash Data | Yes | No | App Functionality | Sentry error reports with no user, account or IP |
| Other Data → Other Data Types | Yes | Yes | App Functionality | 18+ answer, sports and playing level, community-rules acceptance |
| Location, Health, Financial (payment) info, Sensitive info, Contacts, Browsing/Search history, Usage data, Performance data, Audio/Photos | No | — | — | none collected |

Notes:
- **App Functionality** includes "minimize app crashes" in Apple's definitions; there is no analytics use.
- **Server logs with IP addresses** at Vercel and Supabase are kept by the hosting providers for security and are not
  used to identify or profile people. They are not a separate Apple data type. **Legal** to confirm.
- When real payments arrive, add Financial Info only if CourtBook (rather than the provider) receives payment details.
  The current design keeps them at the provider.

## 3. Google Play — Data safety

- **Does your app collect or share any of the required user data types?** Yes.
- **Is all collected data encrypted in transit?** Yes (HTTPS everywhere).
- **Do you provide a way for users to request that their data is deleted?** Yes. In the app, and on the web at
  `https://<domain>/delete-account`.
- **Sharing.** Proposed answer: **no data shared**, with these reasons:
  - Supabase, Vercel, Sentry and Expo process data on our behalf, which Google does not count as sharing.
  - A club sees a player's name and phone only because the player booked at that club, which is a user-initiated
    disclosure the player expects.
  - **Legal** to confirm. If the answer is "shared", declare Personal info → Name and Phone shared with the club, for
    App functionality.

| Google data type | Collected | Optional for the user | Purposes |
| --- | --- | --- | --- |
| Personal info → Name | Yes | No | App functionality, Account management |
| Personal info → Email address | Yes | No | App functionality, Account management |
| Personal info → User IDs | Yes | No | App functionality, Account management |
| Personal info → Phone number | Yes | **Yes** | App functionality |
| Personal info → Other info (18+ answer, sports, level) | Yes | No | App functionality |
| Financial info → Purchase history | Yes | No | App functionality |
| Messages → Other in-app messages | Yes | **Yes** (only if you chat) | App functionality |
| App activity → Other user-generated content (game notes, reports, feedback) | Yes | **Yes** | App functionality |
| App info and performance → Crash logs | Yes | No | Analytics (to fix problems) |
| App info and performance → Diagnostics | Yes | No | Analytics |
| Device or other IDs | **To confirm** (§9 E2) | No | Analytics |
| Location, Financial (payment info), Health, Photos/videos, Audio, Files, Calendar, Contacts, Web browsing, Installed apps, Search history | No | — | — |

## 4. Age rating and target audience

**Apple (new questionnaire, required for all apps since 31 Jan 2026):**
- Content questions: none apply. No violence, no sexual content or nudity, no profanity beyond what users write, no
  drugs, alcohol or tobacco, no gambling or contests, no horror, no medical or wellness content.
- Capabilities:
  - **messaging between users: Yes**;
  - **user-generated content: Yes**, with reporting, blocking, moderation and a filter (see §9 P5);
  - unrestricted web access: No (the in-app browser opens only our own pages and OAuth);
  - advertising: No.
- In-app controls: age assurance — Yes; the app asks for 18+ once, and the database refuses unconfirmed accounts once
  `require_age_confirmation` is on.
- Then **set the higher minimum age: 18+** (decided 23 Nov, L3). Apple lets a developer set a rating above the
  calculated one.

**Google (IARC questionnaire + Target audience and content):**
- IARC asks first for the kind of app: CourtBook is a booking and utility app, not a game and not a social network
  (the chat exists only inside a game). The store category is **Sports**.
- IARC answers:
  - users interact or exchange content: **Yes**;
  - shares the user's location with others: No;
  - digital purchases: No (court bookings are a physical service, paid at the club);
  - unrestricted internet: No.
- **Target audience: 18 and over only.** Not designed for children, so the Families policy does not apply.
- Order required by Play Console: privacy policy, ads declaration (**No ads**) and app access instructions (§8), then
  Target audience and content.

## 5. Permissions and declarations

| Platform | Declared | Store declaration needed |
| --- | --- | --- |
| Android | INTERNET, VIBRATE (normal permissions); SYSTEM_ALERT_WINDOW and external storage explicitly removed (`blockedPermissions`) | None: no sensitive or restricted permission. Target API 36 (meets the 31 Aug 2026 rule) |
| iOS | No usage-description strings (no camera, photos, location, contacts, microphone, tracking); privacy manifest present (4 required-reason APIs, no tracking); `ITSAppUsesNonExemptEncryption = false`; Sign in with Apple capability | Export compliance: already answered "no non-exempt encryption". App Tracking Transparency: not used |
| Both | No push notifications, no background location, no in-app purchases (today) | — |

New native permissions or SDKs: **none added by this branch** (rule kept).

## 6. Listing metadata (draft — Paul approves wording and name)

| Field | Apple limit | Google limit | Draft |
| --- | --- | --- | --- |
| App name | 30 | 30 | **CourtBook** (Paul: confirm, and check the name is free in both stores) |
| Subtitle (Apple) / Short description (Google) | 30 / 80 | — / 80 | Apple: "Book courts. Find players." Google: "Book padel and tennis courts in Lebanon and find players for your game." |
| Category | — | — | Sports (both) |
| Keywords (Apple) | 100 | — | padel,tennis,court,booking,club,players,game,sports,Lebanon,Tripoli,Batroun |
| Promotional text (Apple) | 170 | — | "Book a court at your club in seconds, and find players at your level for your next game." |
| Copyright (Apple) | — | — | "© 2026 [operator]" (Paul) |

**Description (both stores, 4000 limit):**
> CourtBook is the simple way to play padel and tennis in Lebanon.
>
> Book a court: see which courts are free at your club, pick a time and book. You pay the club at the desk as usual.
> Cancel from the app before your booking starts.
>
> Find a game: post a game for your level, or join one near you. Players in the game can chat to organise it.
>
> Know your club: opening hours, courts, prices, how to get there, and how to contact the club.
>
> Safe by design: CourtBook is for adults (18+). Community rules apply to every chat. You can report a message, a game or
> a player, and block anyone. Our team reviews reports.
>
> You can delete your account at any time from your profile.

Check before submission: the description must not mention in-app payment until it exists, nor clubs that are not live.

## 7. Screenshots and graphics

| Store | Required | Specification (checked 23 Nov 2026) |
| --- | --- | --- |
| Apple | iPhone screenshots, at least 1 (up to 10) | "iPhone with Dynamic Island (medium display)": **1179 × 2556 or 1206 × 2622** portrait, PNG/JPEG, no transparency. **No iPad set**: the app does not support iPad (`supportsTablet: false`) |
| Apple | App icon | Taken from the build: `mobile/assets/icon.png` is 1024 × 1024 RGB, no alpha — ready |
| Google | App icon | **512 × 512, 32-bit PNG, ≤ 1 MB** — to export from the same artwork (Eng, 10 min) |
| Google | Feature graphic | **1024 × 500**, required to publish — Paul/designer |
| Google | Phone screenshots | at least 2 (up to 8); shortest side ≥ 320 px, longest ≤ 3840 px |

Proposed set (5 screens, same for both stores): Courts (free times), Booking confirmation, Find a game, Game chat,
Club info. Made from the **store build** with real (or clearly fictional) club data, after the demo club is hidden or
renamed (M7). Not made now: tonight's staging builds are for acceptance only.

## 8. Reviewer access (Apple 2.1, Google "App access") — Paul decides

The live app signs in only by email code, Google or Apple; there is no password sign-in (it exists only in the Staging
app). Reviewers cannot receive codes sent to an address we own.

| Option | How | Trade-off |
| --- | --- | --- |
| **A (recommended)** | Reviewers sign in with **Sign in with Apple** (iOS) or **Google** (Android) using their own account, as any player would; the review notes explain this. So that they can book without disturbing a real club, either keep the demo club visible during review (demo hiding off until launch) or publish a clearly named "CourtBook Review Club" for the review period only | No code change. Needs a bookable club during review that is not a real club; no staff or admin rights for reviewers |
| B | Enable password sign-in in the live app for **one** review account only (server-checked allowlist) | Code change + security review; adds a sign-in path to production |
| C | A fixed one-time code for one review email (Supabase test OTP) | Supabase supports fixed codes for **phone** test numbers, not email — not available for our email sign-in |

Either way:
- Reviewers may test deletion. Our deletion is processed by an admin (by design), so the notes say "request deletion
  from Profile; it is processed by our team".
- Provide a fresh account per submission.

## 9. Remaining blockers

### Paul's decisions
| # | Decision |
| --- | --- |
| P1 | Operator entity, postal address, governing law (L1) — fills the marked items on both pages |
| P2 | Product domain (privacy, terms, deletion and support URLs; also the sign-in email sender) |
| P3 | App name in both stores (and name availability); copyright line |
| P4 | Reviewer access option (§8) and a bookable review club |
| P5 | Message filter word list (Apple 1.2 asks for a filter; the 0074 filter is built, list empty "until approved") |
| P6 | How quickly reports are reviewed (Apple 1.2 "timely responses"; terms item) and who moderates |
| P7 | Approve the "proposed wording" items on the pages (under-18 accounts closed, change notices, no-show limits) |
| P8 | Feature graphic and screenshot style (designer or in-house) |

### Legal (lawyer)
- Final privacy policy and terms wording; Lebanese Law 81/2018 rights and response time.
- Retention of anonymised bookings and payments; processing time (M2b).
- Provider list and transfers; "sharing with clubs" answer for Google; liability clause; consent wording.

### Accounts (Paul, outside the code)
- **Apple Developer Program as an organisation** (company, D-U-N-S number) and **Google Play organisation account**
  (company, D-U-N-S; organisation accounts are exempt from the 12-tester / 14-day closed test that applies to new
  personal accounts).
- App records in App Store Connect and Play Console (bundle / package `app.courtbook.mobile`), availability: **Lebanon
  only** (L2). No EU distribution, so no EU trader-status declaration is needed at launch.
- Sign in with Apple key for the server (needed by E1).

### Engineering
| # | Work | Needs a native build? |
| --- | --- | --- |
| E1 | **Revoke Sign in with Apple tokens on account deletion** (Apple TN3194). The app sends only the identity token today; the server must exchange the authorization code at sign-in (or ask the user to sign in with Apple again when deleting) and call Apple's revoke endpoint in `/api/admin/delete-account` | No (JS + server), but needs the key from the Apple account |
| E2 | Confirm whether native crash reports carry an installation ID (one test crash on staging); if they do, either declare it (§2/§3) or turn it off | No |
| E3 | Store builds with the `production` profile (exists: store distribution, auto-incremented build numbers); crash reporting on for the live apps (L11, needs the live DSN) | Yes (the store build itself) |
| E4 | Google 512 px icon export; screenshots from the store build (§7) | No |
| E5 | `/support` page if Paul wants a support URL other than the email | No |
| E6 | Before submission: payments phase (M12), live rollout of launch-1 and 0085, demo club hidden (M7), age switch on, outside VoiceOver/TalkBack check | Payments: yes |

## Sources (official, read 23 Nov 2026)
- Apple: Updated age ratings in App Store Connect; Age Rating Updates (required since 31 Jan 2026).
- Apple: App Review Guidelines 1.2 (user-generated content), 2.1 (demo account), 5.1.1(v) (account deletion).
- Apple: Offering account deletion in your app; TN3194 (revoking Sign in with Apple tokens).
- Apple: App privacy details on the App Store; Screenshot specifications (App Store Connect Help).
- Google: Understanding Google Play's app account deletion requirements (answer 13327111).
- Google: Target API level requirements (API 36 from 31 Aug 2026).
- Google: App testing requirements for new personal developer accounts (answer 14151465).
- Google: Content ratings (answer 9859655 / 188189); Target audience and content (9867159); Preview assets (9866151);
  icon design specifications.
