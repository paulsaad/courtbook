# CourtBook mobile

The native CourtBook player app (React Native, Expo), in the same repository as the web app and
sharing its Supabase backend. It calls the same RPCs; it does not duplicate any server logic.
The plan is the project doc "CourtBook — native app plan"; this folder started as the proof of
concept and is now milestone M1 (foundation, sign-in, updates). The web app is untouched by
anything in this folder.

## Sending new code to an installed app (EAS Update)

Builds are slow and limited; most changes are JavaScript only and reach phones as an *update*.

- Each build profile has its own channel (`eas.json`): `preview` builds receive `preview` updates.
- `runtimeVersion` follows the app `version` in `app.json`. An update only reaches builds with the
  same version, so JavaScript is never sent to a build whose native code it was not made for.
- **Adding or upgrading anything native** (a new `expo-*` package with native code, a config
  plugin, an SDK upgrade) means: bump `version` in `app.json`, run **Mobile build**, install it.
  The **Mobile update** workflow refuses to publish when no preview build has this exact native
  fingerprint, so a forgotten bump is caught there rather than on a phone.
- GitHub → Actions → **Mobile update (Expo)** → Run workflow:
  - `publish` — checks, then publishes. The run summary lists the update and group IDs.
  - `rollback-to-previous` — paste an earlier group ID from a run summary.
  - `rollback-to-built-in` — phones go back to the code inside their installed build.
- On the phone: close and reopen the app **twice** (download, then run). Profile → About shows
  the update ID now running, or "Built-in".

## Shared code with the web app

`@shared/*` is the web app's `src/lib/*`, imported in place (see `metro.config.js` and the `paths`
in `tsconfig.json`). Only pure files with no web dependencies may be imported. CI installs only
`mobile/`, which proves those files resolve their packages from here.

## Checks

`npm run typecheck`, `npm test`. The **Mobile checks** workflow runs both and bundles both
platforms on every push touching `mobile/` or `src/lib/`.

## What it has to prove

| | What counts as passing |
|---|---|
| 1. Sign-in survives the app being killed | Sign in, force-quit the app, reopen it, still signed in. Both email code and Google. |
| 2. Real availability from the same RPC | The list shows the same free courts as the website for the same day. |
| 3. A booking opens from a push or a link | Tapping a notification opens that booking, not the home screen. |
| 4. A payment return from a gateway sandbox | **A simulated payment is not a sandbox test.** With no gateway credentials this stays *unverified* — it is never marked passed. |

Criteria 1 and 2 are testable with what is in this folder today. Criterion 3 has
its link half (`courtbook://booking/<id>`); push delivery is not wired yet.
Criterion 4 is blocked on gateway credentials and is unrelated to the rest.

## One-time setup

You need a free Expo account. You do not need a Mac, Android Studio, Xcode, or
any developer tools on your own computer. Do these in order — steps 4 and 5
cannot be done before step 3 has run once, because the Expo project does not
exist until then.

1. **Create an Expo account** at expo.dev. Free. No card.
2. **Make an access token**: expo.dev → account settings → Access tokens →
   create one. Copy it. Then in the repo → Settings → Secrets and variables →
   Actions → New repository secret. Name it exactly `EXPO_TOKEN`, paste, save.
3. **Create the Expo project**: GitHub → Actions → **Mobile build (Expo)** →
   Run workflow, and set **init_only** to `true`. This finishes in about a
   minute and builds nothing, so it costs none of the monthly build allowance.
4. **Set the two Supabase values on Expo**: expo.dev → the `courtbook` project
   → Environment variables. Add both to the **preview** environment:
   - `EXPO_PUBLIC_SUPABASE_URL` — the same URL the website uses
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY` — the same anon key the website uses

   Without these the app installs and then cannot reach the database.
5. **Allow the app's sign-in callback in Supabase** — needed for Google only.
   Supabase → Authentication → URL Configuration → Redirect URLs. Add:

   ```
   courtbook://**
   ```

   Supabase refuses any redirect that is not on this list and sends the browser
   to the website instead, so without this the browser never hands the app its
   sign-in code and Google sign-in fails silently. The sign-in screen prints the
   exact URL it uses underneath the Google button; it must match this pattern.

## Build it

GitHub → **Actions** tab → **Mobile build (Expo)** → **Run workflow**. Leave
**init_only** off, the platform on `android` and the profile on `preview`.
Press the green button.

It takes roughly 10–25 minutes; the free queue is low priority, so it can wait
before it starts. When it finishes, go to expo.dev → your project → Builds, and
open the newest one. There is an install page with a QR code.

**On the Android phone**, open that page and install the APK. Android will ask
you to allow installing from that source; that is normal for an app that does
not come from the Play Store.

### If the first build fails

The EAS command line cannot be reached from where this was written, so the
workflow has never been run end to end. The one step most likely to fail the
first time is **signing**: an Android build needs a keystore, and EAS normally
generates one by itself, but a non-interactive first build is where that would
show up if it does not. If the log stops asking about credentials, say so —
the fix is to generate the keystore once, and then every later build reuses it.
Nothing else in the workflow depends on it.

## Why not Expo Go

Expo Go needs a development server running on a computer on the same network to
serve the JavaScript. There is no such computer in this project — the web app is
built by Vercel and the database is managed in Supabase's dashboard. So the app
goes straight to a real build, which is also the only configuration that can
test push notifications and native Google sign-in anyway.

## iPhone

A build that installs on a real iPhone has to be signed, and signing in the
cloud requires the Apple Developer Program at $99 a year. The free route is a
Mac with Xcode. Neither is needed to answer the question this proof of concept
asks, so Android comes first and the iPhone decision waits until criteria 1–3
have passed.

## Layout

```
app/                  screens (expo-router: the file path is the route)
  _layout.tsx         providers, offline banner, root stack
  (tabs)/             Home · Courts · Bookings · Profile
    courts.tsx        today's availability (proof-of-concept screen, until M2)
    profile.tsx       account, sign out, About (build, runtime, channel, update)
  sign-in.tsx         email code, Google, Apple (iOS); opens over the current screen
  booking/[id].tsx    deep-link target: courtbook://booking/<id>
components/           Button, StateView, OfflineBanner, SignInPrompt
lib/
  supabase.ts         client
  secureStorage.ts    session storage that survives app kill (chunked SecureStore)
  session.tsx         sign-in state, one subscription for the app
  query.ts            React Query: retry policy, foreground and online wiring
  errors.ts           failure kinds and plain messages (web's own message table)
  authRecovery.ts     expired session → sign in → back where you were
  appleAuth.ts        Sign in with Apple → Supabase
  buildInfo.ts        what About shows
  theme.ts            design tokens (pending design approval)
__tests__/            jest tests
eas.json              build profiles and their update channels
```

## Running it locally (only if you have a dev machine)

```bash
cd mobile
cp .env.example .env     # fill in the two Supabase values
npm install
npm start
```
