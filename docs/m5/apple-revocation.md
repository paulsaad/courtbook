# E1: Sign in with Apple token revocation on account deletion (proposal, for Paul's decision)

Status: **prepared, not wired, not configured.** `src/lib/apple/revoke.ts` and its tests exist; nothing calls them, and
they do nothing until the company's Sign in with Apple key is set (L14, 24 Nov: runs in the Next.js backend;
credentials only at release). No app change, no route, no migration in this PR.

## Why

The iOS app offers Sign in with Apple. When an account that signed in with Apple is deleted, Apple expects the app's
server to revoke the user's tokens with the REST endpoint `/auth/revoke` (TN3194). This also removes CourtBook from the
person's "Apps using Apple ID" list. Apple's account-deletion requirement asks apps that offer Sign in with Apple to
revoke user tokens with this REST API.

Today the app sends Apple's identity token to Supabase only. CourtBook holds no Apple refresh or access token, so
there is nothing to revoke yet.

## What revocation needs

- `/auth/token` turns an **authorization code** into a refresh token. The code comes from a native Apple sign-in, is
  single-use and expires within minutes.
- `/auth/revoke` revokes that refresh token.
- Both requests carry a client secret: a short JWT signed with the company's Sign in with Apple key (team ID, key ID,
  bundle ID).

## Proposed flow (recommended: a fresh Apple sign-in at deletion; no Apple tokens stored)

Only for accounts with an Apple identity, and only in the iOS app. The website and Android do not offer Apple
sign-in.

1. The person taps Delete and confirms, exactly as today.
2. The app asks them to **confirm with Apple** (the system Apple sheet). This replaces the email code for Apple
   accounts: it is also a recent sign-in.
3. The app sends the new authorization code to a new website route, `POST /api/account/apple-revoke`, with the
   person's session.
4. The server exchanges the code and checks that the Apple user in Apple's answer is **the same Apple ID** as this
   account's Apple identity. Otherwise it refuses, and nothing is revoked or closed.
5. The account is closed (`close_my_account`, unchanged) and the deletion pipeline runs (unchanged).
6. The server revokes the refresh token straight away. The token is never stored; it lives only for that request.

Failures:

| Where | What the person sees | What is recorded |
| --- | --- | --- |
| Apple sheet cancelled | Back to the confirmation; nothing changed | — |
| Code rejected or another Apple ID (step 4) | "That didn't work, and nothing was changed. Please try again." | — |
| Apple unreachable at step 4 | Same; nothing changed | `appleRevokeFailed` (code only) |
| Revoke fails after closing (step 6) | The usual "Your account is closed" | `appleRevokeFailed`, admin alert. The person can remove CourtBook in Settings → Apple ID → Sign in with Apple (Apple's documented manual route) |

Recommendation: closing never waits on Apple after step 4, so a deletion that has started never depends on a third party.

### Alternative (not recommended): store Apple's refresh token at every sign-in

Exchange the code at each Apple sign-in, keep the refresh token encrypted per account, and revoke it during deletion
(retryable by the worker).

- **Pros:** no extra Apple sheet at deletion, and a failed revocation can be retried later.
- **Cons:** CourtBook would hold a long-lived Apple credential for every Apple user, plus a new secret store, a new
  table, encryption and its key rotation. That is more data to protect and declare. A failure at step 6 is rare,
  because the code was exchanged seconds earlier.

## Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| E1-a | Fresh Apple sign-in at deletion (above) or stored refresh tokens | Fresh sign-in: nothing stored |
| E1-b | For Apple accounts, does the Apple confirmation replace the email code? | Yes: one confirmation step, not two |
| E1-c | If revocation fails after closing: closure continues, admin alert | Yes |

## What is built (this PR)

`src/lib/apple/revoke.ts`:
- **Configuration:** `appleConfig()` and `appleConfigProblem()` read `APPLE_TEAM_ID`, `APPLE_KEY_ID`,
  `APPLE_CLIENT_ID` (the bundle ID) and `APPLE_SIGNIN_KEY` (the .p8 PEM). All absent means off. A partial or malformed
  set is a named problem, never echoed.
- **`clientSecret()`:** an ES256 JWT (kid, iss, iat, exp +5 minutes, aud `https://appleid.apple.com`, sub the client
  ID), signed with Node's crypto. No new dependency.
- **`revokeWithCode(code, expectedSub)`:**
  - exchanges the code and trusts the `sub` only from Apple's own answer (issuer checked);
  - revokes nothing for another Apple ID;
  - revokes the refresh token (or the access token if no refresh token is returned);
  - has an 8-second timeout per request;
  - returns short codes only: no token is ever returned or logged.

Tests (`revoke.test.ts`, 11, fake Apple, no network):
- the configuration cases;
- the JWT header, claims and a signature verified with the public key;
- the requests' form fields;
- another Apple ID;
- untrusted `id_token`s;
- Apple refusals and outages;
- nothing sent when not configured;
- no token in any result.

## Left after Paul's decision

- the route and its tests;
- the app's deletion screen for Apple accounts (JS only, over the air);
- the alert;
- company credentials at release (Paul or the Apple account holder, never in chat);
- one real revocation with a test Apple ID on staging (separate approval).
