# M12 real payments — feasibility and minimal implementation plan (for ChatGPT review)

24 Nov 2026. Desk research and code review only.
- No provider was contacted.
- No money was spent.
- No migration was written or run.
- Production and the staging deletion-retry trial were not touched.

Builds on two documents:
- "payments for launch: provider feasibility and architecture" (22 Nov), which holds the models, P1–P9 and the sources;
- "payments preparation (M12 groundwork)" (24 Nov), which holds the hard acceptance criteria and the verified callback behaviour.

Code reviewed: `release-candidate` 90d7fcb. The relevant migrations are 0012, 0014, 0019, 0051–0053, 0055, 0060, 0061, 0065, 0083, 0086 and 0090. The routes reviewed are `src/lib/payments/*` and `src/app/api/pay/*`.

Evidence labels used below:
- **Published**: the provider's or regulator's own site or docs.
- **Third-party**: consistent secondary sources.
- **Community**: unofficial SDK or developer reports.
- **Unknown**: only the provider can answer.

## 1. Decided inputs

| Item | Decision |
| --- | --- |
| Model | **Model 2**: the club collects the court price at the desk; CourtBook collects only its service fee online (Paul) |
| Fee | **$1** per player booking made online; staff/desk bookings stay fee-free (P5) |
| Hard criterion 1 | A successful payment for a different amount becomes a recorded obligation, never an untracked event |
| Hard criterion 2 | A $0 fee never creates a platform-fee payment row |
| Order | No real payments until sandbox-proven; production activation is a separate approval |

## 2. Feasibility verdict

**Technically feasible with small changes.** Model 2 is today's `at_desk` booking plus a $1 online charge. Booking safety is reused unchanged:
- the exclusion constraint;
- holds;
- court-first lock order;
- idempotency tokens.

**Not startable until four outside items are in place.** None of them is code:

1. **Merchant of record.** A legal entity able to hold a merchant account (P2). A small entity is reported to cost $700–2,000 (third-party).
2. **Provider onboarding.** Whish Pay merchant account and sandbox credentials. Fees, API behaviour and refund rules are **Unknown** until Whish answers in writing.
3. **Lawyer opinion.** Three questions:
   - **(a)** Does Model 2 need a BDL licence? Expected no, because no third-party funds are held.
   - **(b)** Could the $1 fee be read as a card surcharge under BDL Decision 13810 / Basic Circular 173, Article 3? Article 3 bars merchants from adding fees for paying by bank card. It has been in effect since 15 Jun 2026. Wallet payments are not clearly covered (Published regulator text, our reading).
   - **(c)** Consumer-law limits on a non-refundable fee, VAT registration and receipts.
4. **Vercel Pro.** Vercel's terms restrict Hobby to personal, non-commercial use, and charging a fee is commercial (Published). This is $20/month and is required before the first real payment. It is not required for sandbox work.

The 1.25% card-fee cap in BDL 13810 applies only to five sectors: fuel, supermarkets, hospitals, pharmacies and large bakeries. **It does not cap what a card acquirer may charge CourtBook.**

## 3. Providers (Lebanon, as of 24 Nov)

| Provider | Onboarding | Fees | API / confirmation | Refunds | Evidence |
| --- | --- | --- | --- | --- | --- |
| **Whish Pay** (wallet) | Whish business account + merchant onboarding | Whish's fee page currently lists **no merchant rows**; the "1%" cited on 22 Nov comes from a third-party article and is **unverified** | Hosted collect link, callback, status lookup; hosts `whish.money/itel-service/api/` (live), `lb.sandbox.whish.money/itel-service/api/` (sandbox) | Refund API; reported to accept calls only from merchant-registered server IPs | Community (unofficial SDK); everything Unknown until confirmed |
| **areeba** (cards) | Commercial onboarding via sales | Custom | Gateway with sandbox and webhooks | Supported | Third-party |
| **NetCommerce** (cards) | Merchant agreement; merchant handles disputes | By agreement | Hosted checkout, APIs, link2Pay | Full and partial | Third-party |
| **MontyPay** (Monty Finance SAL) | Credentials via sales | Custom | API with signed webhooks | Supported | Published developer docs |
| **Bank of Beirut** gateway | Bank merchant agreement | Custom | Exists; details not documented | Unknown | Third-party |
| Tap | Reported **not accepting new Lebanese merchants** | — | — | — | Third-party (conflicts with Tap's Lebanon page) |
| MyFatoorah | Lebanon **not in the supported-country list** | — | — | — | Published |

**Whish behaviours that shape the design.** These are community-reported and must be confirmed in writing:
- a collect link is single-attempt and expires after about 5 minutes;
- a retry needs a **new** external reference, and reusing a reference replays the old request;
- the callback is sent **once**, with no resend and **no callback on expiry**;
- statuses are `pending`, `success`, `failed`, `refunded` and `unknown`.

**Economics on $1.** A percentage fee costs cents. A fixed per-transaction fee decides viability: $0.20 takes 20% of the fee. That is why the card route is "quote first" (P3).

**Apps.** Apple guideline 3.1.3(e) requires non-IAP payment for physical services used outside the app, and Google Play exempts them in the same way. A hand-off to the browser or the Whish app is allowed.

## 4. Code review: integration risks

The current code is the Model 1 shape:
- `hold_slot` writes one `payments` row for court + fee;
- `confirm_payment` (service role only) is the sole path to `paid`.

`confirm_payment` already handles these cases correctly:
- duplicates;
- out-of-order callbacks;
- late success turning into `refund_due`;
- a reference reused by another payment.

All of these were verified on 24 Nov (6C).

### 4.1 Double bookings: no new risk if the lock order is kept

- A payment never creates a booking. `confirm_payment` only confirms an already-held booking.
- A late success becomes `refund_due`, and the slot keeps its one booking.
- The exclusion constraint remains the final guard.

**Rule for M12:** any new table, such as payment attempts, is locked **after** the payment row (club → court → booking → payment → attempt). No path may confirm a booking without the hold. The existing race suites (`booking_races.mjs`, `court_deactivation_race.mjs`) are rerun with the fee-only mode.

### 4.2 Payment-confirmation races

| # | Finding in today's code | Consequence with Whish | Fix in M12 |
| --- | --- | --- | --- |
| R1 | `session_url` is stored once per payment and reused (`/api/pay/simulate`) | A single-attempt link expires after about 5 minutes while the hold lasts 10 (`hold_minutes`), so a reused link is dead | `payment_attempts` table: one row per provider request, own id = Whish external reference, never reused |
| R2 | No poller; confirmation relies on the provider calling back | A callback is sent once and never on expiry, so one lost callback leaves a paid player with an expired hold | (a) The return page calls the status API synchronously. (b) A sweeper polls every open attempt. A late success → `refund_due` (existing logic) |
| R4 | `fail_payment` expires the hold on a single failure | One declined attempt kills the slot although the player could retry | A failed attempt fails only the attempt. The hold ends on its timer or on release |
| R9 | `provider_ref` is unique on `payments` | Several attempts per payment cannot all store their reference there | Reference on the attempt; `payments.provider_ref` = the attempt that succeeded |
| R12 | The callback signature scheme is unknown | A forged callback could confirm a booking | The callback carries no authority: it only triggers a server-side status lookup, and the status lookup confirms |
| R16 | Two attempts can both succeed | The second hits `payment_mismatch` and is not recorded: real money untracked | The second success is recorded on its attempt as a duplicate and becomes a refund obligation (generalises criterion 1) |
| R18 | Vercel Schedules: minimum every 15 minutes, 15-minute jitter | The sweeper cannot drive the user experience inside a 10-minute hold | Return page and client poll drive the user experience; the sweeper only resolves orphans. The Hobby limit is 5,000 runs per period per team, and deletion retry alone uses about 2,880 per environment, another reason Pro is required |

### 4.3 Incorrect refunds

| # | Finding | Consequence | Fix |
| --- | --- | --- | --- |
| R3 | `amount_mismatch` raises and records nothing (C7) | Money received, no record (**criterion 1**) | Record it on the attempt with the amount received, mark it for reconciliation and make it a refund obligation; rewrite C7 |
| R7 | `cancel_booking` (0083) marks the whole payment `refund_due` before the cutoff | Under Model 2 and P4, a player cancellation keeps the fee | Mode-aware refund rule (decision D1) |
| R8 | The same rule is **duplicated inline** in account deletion (0086), and club-caused cancellation and court deactivation reach it too | The two copies can drift, refunding in one path and not in another | One shared function `fee_refund_due(booking, reason)` used by every cancel path; a test per path |
| R17 | `mark_refunded` (0061) is callable by **club staff** and records only a status | Under Model 2 the fee is CourtBook's money: club staff could mark a CourtBook refund done, and no refund reference is kept | Fee refunds are admin- or job-only and store the provider refund reference, amount and time |
| R5 | Whish refunds reportedly need a registered fixed server IP; Vercel egress is dynamic | API refunds need Vercel Static IPs at $100/month per project (Pro) | Launch with **manual refunds**: admin refunds in the Whish merchant portal and records the reference (decision D3) |

### 4.4 Model and display

| # | Finding | Fix |
| --- | --- | --- |
| R6 | No fee-only mode; `at_desk` has no online charge (`book_at_desk`), `simulated` charges court + fee | New club mode (working name `fee_online`). Hold writes a payment with `amount_usd = 0`, `fee_usd = 1`, `total_usd = 1`. If the club's fee is $0, the request takes the `book_at_desk` path and creates **no** payment row (**criterion 2**). `club_balances` and payouts stay untouched (`owed_to_club` = 0) |
| R15 | The staff calendar shows "+ $1.00 fee · paid in the app" | Must read "Court $X due at the desk · $1 booking fee paid online"; a staff misreading means an unpaid court |
| R10 | USD only (P7) | Refuse any provider response in another currency (recorded as a mismatch) |
| R11 | App flow | Hand-off to the browser or Whish app, then return by deep link. No native module, so an app update only, not a native build (to confirm when designing) |
| R13 | Reconciliation source unknown | Daily comparison of provider transactions with attempts; the source (API or statement export) is a question for Whish |
| R14 | Fee may be read as a card surcharge | Lawyer question 3(b) before card methods |

## 5. Minimal implementation plan

Every milestone ends with Paul testing against its checks. Nothing reaches production before M12.7.

| Milestone | Content | Effort (mine) | Gate |
| --- | --- | --- | --- |
| **M12.0 Outside items** | Entity, lawyer questions, Whish written questions (§3 list + fees, IP rule, reconciliation export), card quote (P3, P8). I draft; Paul or the operator sends | — (calendar 4–8 weeks) | Answers in writing |
| **M12.1 Database, fee-only mode** | Mode `fee_online`; fee-only hold; $0 → `book_at_desk`; `payment_attempts`; `confirm_attempt` (status-lookup driven), recording mismatches and duplicates; attempt failure ≠ hold failure; shared `fee_refund_due`; admin-only fee refunds with reference. Migrations drafted after 0092, tested only on throwaway Postgres | 5–6 days | Review; your approval before any staging migration |
| **M12.2 Provider adapter (Whish)** | `start`, `status`, `refund` (manual stub at launch); callback route → status lookup; return-page verify; orphan sweeper (Vercel Schedule) | 5–6 days | Needs sandbox credentials |
| **M12.3 Website pay flow** | Fee shown before confirming; retry within the hold; clear "court price due at the club"; staff calendar wording (R15) | 2–3 days | Phone test |
| **M12.4 App pay flow** | Hand-off and return; update via the existing OTA channel if no native module | 3–5 days | Phone test (iOS and Android) |
| **M12.5 Refunds and reconciliation** | Refund queue for fee refunds; daily reconciliation job; Sentry alerts on mismatch, orphan or duplicate | 3 days | Review |
| **M12.6 Sandbox campaign** | Both hard criteria; R1–R18 as tests (duplicate, lost and out-of-order callbacks, expired link, two successes, wrong amount, late success after slot taken, cancel in each path); race suites with fee-only mode; mutation checks | 4–5 days | ChatGPT review + your approval |
| **M12.7 Security review, staging soak, live $1 test** | Independent review of the payment path; staging soak; you make real $1 payments and one refund | 1–2 weeks calendar | Your approval for production |
| **M12.8 Production activation** | Club by club, starting with one | — | Separate approval |

**Total development:** about 4–5 weeks, overlapping M12.0.
**Realistic first real payment:** 10–14 weeks from the entity decision; outside parties are the critical path.

## 6. Costs

| Item | Cost | When | Evidence |
| --- | --- | --- | --- |
| Vercel Pro | $20/month per member | Before the first real payment | Published |
| Vercel Static IPs | $100/month per project | Only if API refunds are chosen (D3) | Published |
| Whish Pay transaction fees | Unknown | Per payment | Ask Whish |
| Card provider | Custom; fixed fee decides viability | Only if added (P3) | Quote |
| Legal entity | ~$700–2,000 registration + lawyer/accountant | M12.0 | Third-party / quotes |
| Lawyer opinion (3 questions) | Quote | M12.0 | — |
| Independent security review | Quote | M12.7 | — |
| Live test payments | A few dollars | M12.7 | — |

## 7. Decisions needed from Paul

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Fee refund rule (P4 refined) | **Refund:** club cancels, court closed, late success, duplicate or wrong amount. **Keep:** player cancels (any time) or no-show. **Account deletion:** same as a player cancellation. Lawyer to confirm consumer-law limits |
| D2 | Retries within a hold | Allowed, at most 3 attempts per hold; the hold timer is not extended |
| D3 | Refunds at launch | **Manual** (admin in the Whish portal + recorded reference); API refunds and Static IPs only if volume justifies $100/month |
| D4 | Vercel Pro | Required before the first real payment (Vercel terms); not before |
| D5 | Methods at launch | Whish Pay only; card provider quoted in parallel (P3) |
| D6 | Merchant of record and lawyer | The entity (P2); lawyer gets questions 3(a)–(c) |
| D7 | Fee wording to players | "CourtBook booking fee $1 — not refunded if you cancel; the court is paid at the club" (subject to D1 and the lawyer) |
| D8 | M12.1 scope | Approve drafting the migrations and tests on this branch (throwaway Postgres only; nothing applied to staging) |

## 8. Out of scope here

- Model 1 (the platform collects the court price): needs a licence opinion and a split-settlement provider.
- Card payments before the lawyer's answer to question 3(b).
- Any production change.
