# E1: Sign in with Apple token revocation on account deletion

Status: **prepared, not wired, not configured.**
- `src/lib/apple/revoke.ts` and `src/lib/apple/deletion.ts` exist with their tests. No route, app screen or migration
  calls them.
- Nothing runs until the company's Sign in with Apple key is set. L14 (24 Nov): this runs in the Next.js backend, and
  credentials are added only at release.

## Decisions (Paul, 25 Nov)

| # | Decision |
| --- | --- |
| E1-a | **Fresh Apple authentication at deletion; no long-lived Apple refresh tokens stored** |
| E1-b | **Apple authentication may replace the email code only if it satisfies the existing Supabase recent-authentication requirement** |
| E1-c | **Deletion continues if revocation fails, with an operational alert** |

## Review corrections (25 Nov), and where each is handled

| # | Correction | How |
| --- | --- | --- |
| 1 | Verify the Apple identity token's signature, audience, issuer and expiry, not just the decoded subject | `verifyAppleIdToken()` checks, in this order: the RS256 signature against Apple's published keys (`/auth/keys`, cached one hour, refetched once for an unknown key id); `alg` must be RS256 (none/HS256/ES256 refused); `iss` = `https://appleid.apple.com`; `aud` contains our client id; `exp` not passed and `iat` not in the future (60 s clock skew); `sub` present. Only then is `sub` used. If Apple's keys are unreachable, that is an outage, never a verdict |
| 2 | Separate code exchange and identity verification from revocation | Three functions: `exchangeCode()`, `verifyAppleIdToken()` and `revokeToken()`. The ordering is in `closeAppleAccount()`, and each step can be replaced in tests |
| 3 | Deletion stays possible when Apple is unavailable; secure fallback; existing safety rules preserved | **Fallback** = the existing email-code confirmation, then the same database closure. Revocation is recorded as skipped with an alert, and the person is told how to remove CourtBook from their Apple ID settings. Every closure still goes through `close_my_account` as the person, so the recent sign-in, staff/admin refusals and paused-processing rules are all unchanged |
| 4 | Full-flow tests | `deletion.test.ts`, 18 tests (below) |
| 5 | Expected Apple identity from server-side identity records only | `appleSubsFromUser()` reads the identities of the **authenticated** user from Supabase's admin API, and only those with provider `apple`. The request carries no identifier; a forged one is ignored (tested) |

## The flow

```
app: "Delete" → confirm → Apple sheet ──────────────┐ cancelled / unavailable → fallback: email code (existing)
     the same sheet gives an identity token and a one-time code
     1. app: Supabase sign-in with the Apple identity token (Supabase verifies it; fresh session = recent sign-in, E1-b)
     2. app → website route (future): { method: "apple", code }      or      { method: "fallback" }
server (closeAppleAccount):
     a. Apple ids of the SIGNED-IN account, server-side            none → "not_apple_account" (ordinary deletion)
     b. recently_authenticated() as the person, read-only          false → reauth_required (Apple not contacted)
     c. apple only: exchange the code → verify the id_token → sub must be one of (a)
                                                                    any failure → nothing closed
     d. close_my_account as the person (the database decides; any refusal → nothing revoked)
     e. the existing deletion processing (B–E), unchanged
     f. apple: revoke → failure = alert "appleRevokeFailed", still closed       fallback: alert "appleRevocationSkipped"
```

E1-b: the server never grants recency. A confirmation with Apple counts only because step 1 is a real Supabase
sign-in, and the database's own 10-minute rule (`recently_authenticated()`, 0086) accepts it. The email code (the
fallback) satisfies the same rule in the same way.

| Situation | Result | Closed? | Revoked? | Alert |
| --- | --- | --- | --- | --- |
| All good | `closed, revocation done` | yes | yes | — |
| Session not recent | `reauth_required` | no | no | — |
| Apple sheet cancelled (no code) | `apple_code_missing`; the app offers the fallback | no | no | — |
| Code rejected or reused | `apple_code_rejected` | no | no | — |
| Verified token for another Apple ID | `wrong_apple_account` | no | no | — |
| Token fails verification | `apple_identity_unverified` | no | no | `appleIdentityRejected` (possible forgery) |
| Apple down (exchange or keys) | `apple_unavailable`; the app offers the fallback | no | no | — |
| Staff, admin, processing paused | the database's code | no | no | — |
| Revocation fails after closing | `closed, revocation failed` | yes | no | `appleRevokeFailed` |
| Processing fails after closing | `closed`; revocation still runs | yes | yes | (the pipeline records its own failure) |
| Fallback | `closed, revocation skipped` | yes | no | `appleRevocationSkipped` |

Tokens: the refresh token (or the access token if Apple returns no refresh token) exists only in memory during the
request, inside `AppleToken`, which prints and serialises as `[apple token]`. Nothing about Apple is stored.

## Tests (no network; fake Apple)

- `revoke.test.ts` (13):
  - configuration;
  - the client-secret JWT, verified with its public key;
  - exchange: fields, refusals, outages;
  - id_token verification: valid; another key; a tampered payload; `none`/`HS256`/`ES256`; wrong issuer; wrong
    audience; expired; issued in the future; no subject; unknown key refetched once; keys unreachable; malformed;
  - revoke: outcomes;
  - tokens never printed.
- `deletion.test.ts` (18):
  - the full order;
  - each point-4 case: a stale session caught both before Apple is contacted and by the database at closure; Apple
    cancellation followed by the fallback; the wrong Apple ID; an unverifiable token; outages at the exchange and at
    the keys; a rejected code; revocation failing three ways after closure; processing failing after closure; an
    account with both email and Apple sign-in;
  - existing refusals for both methods;
  - the fallback still needs a recent sign-in;
  - lookup failures;
  - a forged client identifier;
  - identity parsing;
  - an unknown method.
- Mutation check: nine deliberate faults are each caught. These are removing the identity match, the recency check,
  the "not closed → no revoke" rule, the revoke-failure alert, and the audience, signature, expiry, issuer and
  algorithm checks.

## Left, after this is reviewed again

1. **The route**, `POST /api/account/apple-delete`. It authenticates the person from their own session, builds the real
   dependencies and calls `closeAppleAccount`, with route tests.
2. **The app's deletion screen for Apple accounts**: the Apple sheet, the Supabase sign-in, the call, the fallback
   offer, and the "remove CourtBook in Settings → Apple ID → Sign in with Apple" text after a skipped or failed
   revocation. JavaScript only, so it can go over the air.
3. **Old app versions.** They close Apple accounts through the existing direct path, with no revocation. Proposal:
   the deletion processing raises `appleRevocationSkipped` when it deletes a sign-in that has an Apple identity and no
   recorded revocation.
4. **Alert routing** into the existing monitoring (W2a).
5. **Company credentials** at release, set by Paul or the Apple account holder, never in chat. Then one real
   revocation with a test Apple ID on staging (separate approval).
