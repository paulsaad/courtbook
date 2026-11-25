// M12.4: the app's payment endpoints (/api/native/pay/start and /status) — the REAL route modules, the REAL shared
// payment code (src/lib/payments/startFlow.ts) and the REAL database through Supabase's API (local PostgREST), with
// players signed in by their own access tokens. Faked: Supabase Auth's token check (shims/authjs.mjs — signature,
// expiry, role, existing user, as Auth checks them) and the payment gateway (below: generic hosted-page behaviour, not
// Whish). LOCAL ONLY: never staging or production.
//   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh && SCRIPT=native.mjs PSQL="sudo -u postgres psql" bash supabase/tests/api/journey.sh
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { API_URL, API_DB, ANON_KEY, asUser, jwt } from "./lib.mjs";
import { PaymentStartRefused } from "../../../src/lib/payments/provider.ts";
import { simulatedProvider } from "../../../src/lib/payments/simulated.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

process.env.NEXT_PUBLIC_SUPABASE_URL = API_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON_KEY;
process.env.PAYMENT_SITE_URL = "https://courtbook.example";
process.env.NATIVE_PAYMENTS = "1";
const start = await import("../../../src/app/api/native/pay/start/route.ts");
const status = await import("../../../src/app/api/native/pay/status/route.ts");
const reported = (globalThis.__reported ??= []);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];

// ------------------------------------------------------------------ a generic hosted-page gateway (not Whish)
const gw = {
  name: "whish", pages: new Map(), starts: [], statusAsked: 0, next: [], n: 0,
  // a real provider with its own charge list (#40: without one, real payments cannot start); empty here: these
  // journeys settle every charge through its attempt
  async listCharges() { return []; },
  async startAttempt(input) {
    this.starts.push(input);
    const mode = this.next.shift() ?? "ok";
    if (mode === "refused") throw new PaymentStartRefused("declined");
    if (mode === "timeout_before") throw new Error("timeout");           // the request never reached it
    const page = { url: `https://gw.test/s/${++this.n}`, state: "pending", amount: input.amountUsd, ref: `GW-${this.n}` };
    this.pages.set(input.attemptId, page);
    if (mode === "timeout_after") throw new Error("timeout");            // the page exists; the answer was lost
    await new Promise((ok) => setTimeout(ok, 30));                       // a real provider takes a moment
    return { kind: "redirect", url: page.url, session: `S-${this.n}` };
  },
  async attemptStatus(id) {
    this.statusAsked++;
    if (this.down) throw new Error("unavailable");
    const p = this.pages.get(id);
    if (!p) return { state: "pending" };                                 // unknown references are never failures here
    if (p.state === "paid") return { state: "succeeded", evidence: { providerRef: p.ref, amount: p.amount, currency: "USD" } };
    return { state: p.state };
  },
  pay(id) { this.pages.get(id).state = "paid"; },
  fail(id) { this.pages.get(id).state = "failed"; },
  start() {}, verify() {}, refund() {},
};

// ------------------------------------------------------------------ fixtures
const U = (n) => `a4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const players = Array.from({ length: 30 }, (_, i) => U(i + 1));
const STAFF = U(90), ADMIN = U(91);
await q("insert into auth.users (id, phone) select x, '+9617140' || lpad(n::text, 4, '0') from unnest($1::uuid[]) with ordinality t(x, n) on conflict do nothing", [[...players, STAFF, ADMIN]]);
await q("update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app' where id = any($1)", [[...players, STAFF, ADMIN]]);
await q("update profiles set roles = '{player,admin}' where id = $1", [ADMIN]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
await q("update clubs set payment_mode = 'fee_online', service_fee_usd = 1, hold_minutes = 10, max_upcoming_bookings = 20 where id = $1", [CLUB]);
await q("insert into club_staff (club_id, profile_id) values ($1,$2) on conflict do nothing", [CLUB, STAFF]);
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
let courtN = 0, playerN = 0;
const newCourt = async (club = CLUB) => {
  const id = await one("insert into courts (club_id, name, sport, sort) values ($1, $2, 'padel', 960) returning id", [club, `zz-nat-${++courtN}`]);
  await q("insert into price_rules (club_id, court_id, weekday_mask, start_time, end_time, price_usd, label) values ($1, $2, 127, '00:00', '23:59', 25, 'nat')", [club, id]);
  return id;
};
/** An access token the way Supabase Auth issues one. */
const tokenFor = (id, over = {}) => jwt({ sub: id, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) }], session_id: randomUUID(), ...over });

async function hold(opts = {}) {
  const who = opts.who ?? players[playerN++];
  const p = asUser(who);
  const court = opts.court ?? await newCourt(opts.club);
  const { data, error } = await p.rpc("hold_slot", { p_club: opts.club ?? CLUB, p_court: court, p_start: await at(3, "10:00"), p_end: await at(3, "11:00"), p_token: randomUUID() });
  if (error) throw new Error(`hold: ${error.message}`);
  if (opts.provider !== "simulated" && data[0].payment_id) await q("update payments set provider = 'whish' where id = $1", [data[0].payment_id]);
  return { who, token: tokenFor(who), booking: data[0].booking_id, payment: data[0].payment_id, expires: data[0].hold_expires_at };
}
const NONE = Symbol("no Authorization header");
const call = async (route, path, body, token) => {
  const headers = { "content-type": "application/json" };
  if (token !== NONE) headers.authorization = `Bearer ${token}`;
  const r = await route.POST(new Request(`https://courtbook.example${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
};
const pay = (x, key = randomUUID(), token = x.token) => call(start, "/api/native/pay/start", { paymentId: x.payment, requestKey: key }, token);
const look = (x, token = x.token) => call(status, "/api/native/pay/status", { paymentId: x.payment }, token);
const attemptsOf = (x) => q("select id, status, attempt_no from payment_attempts where payment_id = $1 order by attempt_no", [x.payment]);
const row = async (x) => (await q("select b.status as booking, p.status as payment, b.hold_expires_at from bookings b join payments p on p.booking_id = b.id where b.id = $1", [x.booking]))[0];
const elapse = async (x, minutes) => {
  await q("update bookings set hold_expires_at = hold_expires_at - $2::interval where id = $1", [x.booking, `${minutes} minutes`]);
  await q("update payment_attempts set created_at = created_at - $2::interval where payment_id = $1", [x.payment, `${minutes} minutes`]);
};
globalThis.__provider = gw;

console.log("--- F1 journeys");
{
  const x = await hold();
  const before = await row(x);
  const r = await pay(x);
  const att = (await attemptsOf(x))[0];
  rep("N1 fee_online, fee > 0: the hold is pending with a fee-only payment; start returns the gateway's page; nothing confirmed yet",
    before.booking === "pending" && r.status === 200 && r.body.redirect?.startsWith("https://gw.test/s/") && att?.status === "open" && (await row(x)).booking === "pending" && r.cache === "no-store", { before, r, att });
  const input = gw.starts.at(-1);
  rep("N2 the provider is given the app return page (carrying nothing) and the configured callback — no token, no payment, no attempt in either",
    input.returnUrl === "https://courtbook.example/pay/app-return" && input.callbackUrl === "https://courtbook.example/api/pay/callback/whish"
    && !input.returnUrl.includes(x.payment) && !JSON.stringify(input).includes(x.token.split(".")[2]), input);
  const s1 = await look(x);
  rep("N3 returning without paying (or a redirect that proves nothing): status asks the provider and stays payment_open", s1.body.state === "payment_open" && s1.body.attemptsLeft === 2, s1);
  gw.pay(att.id);
  const s2 = await look(x);
  const charges = await q("select disposition from fee_charges where payment_id = $1", [x.payment]);
  rep("N4 paid at the provider, no callback ever: status settles it — confirmed, paid, one kept $1 charge",
    s2.body.state === "confirmed" && (await row(x)).booking === "confirmed" && (await row(x)).payment === "paid" && charges.length === 1 && charges[0].disposition === "kept", { s2, charges });
  const again = await pay(x);
  rep("N5 tapping Pay again after confirmation never charges twice (not payable)", again.status === 409 && again.body.error === "not_payable" && again.body.final === true && gw.starts.filter((s) => s.attemptId === att.id).length === 1, again);
}
{
  const DEMO = CLUB;   // batroun is a demo club: the simulated provider
  globalThis.__provider = simulatedProvider;
  const x = await hold({ provider: "simulated" });
  const r = await pay(x);
  rep("N6 demo club with the simulated provider: one tap, confirmed at once, nothing collected", r.status === 200 && r.body.outcome && (await row(x)).booking === "confirmed"
    && (await one("select bool_or(collected) from fee_charges where payment_id = $1", [x.payment])) === false && (await look(x)).body.state === "confirmed", r);
  globalThis.__provider = gw;
  void DEMO;
}
{
  const ZERO = await one("insert into clubs (name, slug, town_id, active, payment_mode, service_fee_usd, is_demo) select 'Zero Fee', 'zz-nat-zero', town_id, true, 'fee_online', 0, true from clubs where id = $1 returning id", [CLUB]);
  const who = players[playerN++];
  const court = await newCourt(ZERO);
  const { data } = await asUser(who).rpc("hold_slot", { p_club: ZERO, p_court: court, p_start: await at(3, "12:00"), p_end: await at(3, "13:00"), p_token: randomUUID() });
  rep("N7 fee_online with a $0 fee: confirmed at once, no payment row, nothing for the endpoints to do", data?.[0]?.payment_id == null && data?.[0]?.hold_expires_at == null
    && (await one("select status from bookings where id = $1", [data?.[0]?.booking_id])) === "confirmed", data);
}
{
  const x = await hold();
  gw.next.push("ok");
  const r1 = await pay(x);
  gw.fail((await attemptsOf(x))[0].id);
  const s = await look(x);
  const r2 = await pay(x);
  gw.fail((await attemptsOf(x))[1].id);
  await look(x);
  const r3 = await pay(x);
  gw.fail((await attemptsOf(x))[2].id);
  await look(x);
  const r4 = await pay(x);
  rep("N8 a failed payment keeps the hold: awaiting_payment with tries left; at most three attempts, then attempts_exhausted (final)",
    !!r1.body.redirect && s.body.state === "awaiting_payment" && s.body.attemptsLeft === 2 && !!r2.body.redirect && !!r3.body.redirect
    && r4.status === 409 && r4.body.error === "attempts_exhausted" && r4.body.final === true && (await attemptsOf(x)).length === 3 && (await row(x)).booking === "pending",
    { s: s.body, r4: r4.body });
  rep("N9 no attempt moved the hold's deadline", new Date((await row(x)).hold_expires_at).getTime() === new Date(x.expires).getTime());
}

console.log("--- F2 races and resilience");
{
  const x = await hold();
  const key = randomUUID();
  const startsBefore = gw.starts.length;
  const rs = await Promise.all(Array.from({ length: 6 }, () => pay(x, key)));
  const urls = new Set(rs.map((r) => r.body.redirect).filter(Boolean));
  rep("N10 a double (sextuple) tap with one request key: one attempt, one gateway start, one page; no answer is an error",
    (await attemptsOf(x)).length === 1 && gw.starts.length - startsBefore === 1 && urls.size === 1 && rs.every((r) => r.body.redirect || r.body.error === "payment_in_progress"),
    rs.map((r) => r.body));
}
{
  const x = await hold();
  const startsBefore = gw.starts.length;
  const rs = await Promise.all(Array.from({ length: 6 }, () => pay(x)));   // six different keys (six devices)
  const att = await attemptsOf(x);
  rep("N11 concurrent taps with different keys: never two unresolved attempts, at most one gateway start",
    att.filter((a) => ["starting", "open"].includes(a.status)).length <= 1 && gw.starts.length - startsBefore <= 1 && att.length === 1,
    { att, rs: rs.map((r) => r.status) });
}
{
  const x = await hold();
  const key = randomUUID();
  gw.next.push("timeout_after");
  const r1 = await pay(x, key);
  const att = (await attemptsOf(x))[0];
  const s1 = await look(x);
  const startsBefore = gw.starts.length;
  const r2 = await pay(x, key);                       // the app's manual retry with the SAME key
  const r3 = await pay(x);                            // even another key: the unresolved one is asked about first
  rep("N12 provider timeout: payment_uncertain (not final, key kept), the attempt stays 'starting', status says checking; retrying never starts a second payment",
    r1.status === 502 && r1.body.error === "payment_uncertain" && r1.body.final === false && att.status === "starting" && s1.body.state === "checking"
    && gw.starts.length === startsBefore && (await attemptsOf(x)).length === 1 && r2.body.error === "payment_in_progress" && r3.body.error === "payment_in_progress",
    { r1: r1.body, s1: s1.body, r2: r2.body, r3: r3.body });
  gw.pay(att.id);                                     // the player had paid on the page that did exist
  const s2 = await look(x);
  rep("N13 ...and when the provider says it was paid, status confirms it (one charge, kept)", s2.body.state === "confirmed"
    && (await one("select count(*)::int from fee_charges where payment_id = $1 and disposition = 'kept'", [x.payment])) === 1, s2.body);
}
{
  const x = await hold();
  await pay(x);
  gw.down = true;
  const s = await look(x);
  gw.down = false;
  rep("N14 provider unreachable while checking: the answer is the last known state (payment_open), reported by code only, never 'paid'",
    s.status === 200 && s.body.state === "payment_open" && reported.some(([k, , d]) => k === "paymentProvider" && d.code === "provider_unavailable"), s.body);
}
{
  // M12.1 rule (0014/0090, record_attempt_result): a pending hold just past its deadline still owns the slot until it
  // is swept, so money arriving then confirms it. Once swept, the same money is owed back.
  const x = await hold();
  await pay(x);
  await elapse(x, 11);                                // the hold ran out while the page was open, not yet swept
  const s1 = await look(x);
  gw.pay((await attemptsOf(x))[0].id);
  const s2 = await look(x);
  rep("N15 hold past its deadline but not yet swept, page open: still payment_open; money arriving then confirms it (the accepted M12.1 rule)",
    s1.body.state === "payment_open" && s2.body.state === "confirmed" && (await row(x)).booking === "confirmed", { s1: s1.body, s2: s2.body });

  const y = await hold();
  await pay(y);
  await elapse(y, 11);
  await q("select expire_stale_holds((select court_id from bookings where id = $1))", [y.booking]);   // the sweep
  const t1 = await look(y);
  gw.pay((await attemptsOf(y))[0].id);
  const t2 = await look(y);
  const ch = await q("select disposition, reason from fee_charges where payment_id = $1", [y.payment]);
  rep("N15b hold swept with a page open: checking (money may still come, the page is never offered again); late money is owed back — never confirmed",
    (await row(y)).booking !== "confirmed" && t1.body.state === "checking" && t2.body.state === "refund_due" && t2.body.refundsDue === 1
    && ch.length === 1 && ch[0].disposition === "refund_due" && ch[0].reason === "not_confirmed", { t1: t1.body, t2: t2.body, ch });
  const again = await pay(y);
  rep("N15c ...and no new attempt can start on it", again.status === 409 && again.body.final === true && (await attemptsOf(y)).length === 1, again.body);
}
{
  const x = await hold();
  await elapse(x, 11);
  const r = await pay(x);
  const s = await look(x);
  rep("N16 after the hold expired no attempt can start (hold_expired, final); status says hold_expired", r.status === 409 && r.body.error === "hold_expired" && r.body.final === true
    && (await attemptsOf(x)).length === 0 && s.body.state === "hold_expired", { r: r.body, s: s.body });
}
{
  const x = await hold();
  gw.next.push("refused");
  const r = await pay(x);
  const s = await look(x);
  rep("N17 a definite refusal ends that attempt only: gateway_error (final), the hold stays, status awaiting_payment with 2 tries", r.status === 502 && r.body.error === "gateway_error"
    && r.body.final === true && s.body.state === "awaiting_payment" && s.body.attemptsLeft === 2 && (await row(x)).booking === "pending", { r: r.body, s: s.body });
}

console.log("--- F3 security");
{
  const victim = await hold();
  await pay(victim);
  const vAtt = (await attemptsOf(victim))[0];
  const thief = players[playerN++];
  const tt = tokenFor(thief);
  const startsBefore = gw.starts.length, askedBefore = gw.statusAsked;
  const s = await pay(victim, randomUUID(), tt);
  const l = await look(victim, tt);
  rep("N18 another player cannot start or inspect someone's payment: both answer not_found, exactly as for a payment that does not exist; the gateway is never called",
    s.status === 404 && s.body.error === "not_found" && l.status === 404 && l.body.error === "not_found" && gw.starts.length === startsBefore && gw.statusAsked === askedBefore
    && (await attemptsOf(victim)).length === 1, { s: s.body, l: l.body });
  const nx = await look({ payment: randomUUID(), token: tt });
  rep("N19 ...indistinguishable from a made-up payment id", nx.status === 404 && JSON.stringify(nx.body) === JSON.stringify(l.body));
  const sStaff = await look(victim, tokenFor(STAFF));
  const sAdmin = await look(victim, tokenFor(ADMIN));
  rep("N20 club staff and admins (who may READ the club's payments) still cannot use the player's payment endpoint", sStaff.status === 404 && sAdmin.status === 404, { sStaff: sStaff.body, sAdmin: sAdmin.body });
  const tp = asUser(thief);
  const tries = [
    await tp.rpc("record_attempt_result", { p_attempt: vAtt.id, p_result: "succeeded", p_provider_ref: "X", p_amount: 1, p_currency: "USD" }),
    await tp.rpc("open_payment_attempt", { p_attempt: vAtt.id, p_session_url: "https://evil.example", p_provider_session: "x" }),
    await tp.rpc("abandon_payment_attempt", { p_attempt: vAtt.id, p_note: "x" }),
    await tp.rpc("confirm_payment", { p_payment: victim.payment, p_provider_ref: "X" }),
    await tp.rpc("start_payment_attempt", { p_payment: victim.payment, p_request: randomUUID() }),
  ];
  const me = asUser(victim.who);
  const own = await me.rpc("record_attempt_result", { p_attempt: vAtt.id, p_result: "succeeded", p_provider_ref: "X", p_amount: 1, p_currency: "USD" });
  rep("N21 nobody can confirm a payment from the outside — not another player, not even the owner: the server functions refuse; nothing changed",
    tries.every((t) => !!t.error) && !!own.error && (await row(victim)).booking === "pending" && (await one("select count(*)::int from fee_charges where payment_id = $1", [victim.payment])) === 0
    && (await one("select status from payment_attempts where id = $1", [vAtt.id])) === "open", { tries: tries.map((t) => t.error?.message), own: own.error?.message });
  const r = await tp.from("payment_attempts").select("id, session_url").eq("id", vAtt.id);
  rep("N22 another player cannot read someone's payment page link from the table either", !r.error ? (r.data ?? []).length === 0 : true, r.data);
}
{
  const x = await hold();
  const forged = x.token.slice(0, -3) + (x.token.endsWith("AAA") ? "BBB" : "AAA");
  const expired = tokenFor(x.who, { exp: Math.floor(Date.now() / 1000) - 10 });
  const ghost = tokenFor(randomUUID());
  const svc = jwt({ role: "service_role" });
  const answers = [];
  for (const t of [NONE, "", forged, expired, ghost, ANON_KEY, svc, "not.a.jwt"]) answers.push((await pay(x, randomUUID(), t)).status, (await look(x, t)).status);
  rep("N23 no token, a forged or expired token, a deleted user's token, the anon key or a service-role key: 401 on both endpoints, nothing created",
    answers.every((s) => s === 401) && (await attemptsOf(x)).length === 0, answers);
  const bad = [];
  for (const b of [{}, { paymentId: x.payment }, { paymentId: "x", requestKey: randomUUID() }, { paymentId: `${x.payment}' or 1=1`, requestKey: randomUUID() }])
    bad.push((await call(start, "/api/native/pay/start", b, x.token)).status);
  rep("N24 malformed input: 400, nothing created", bad.every((s) => s === 400) && (await attemptsOf(x)).length === 0, bad);
  process.env.NATIVE_PAYMENTS = "0";
  const off = [(await pay(x)).status, (await look(x)).status];
  process.env.NATIVE_PAYMENTS = "1";
  rep("N25 with the deployment switch off: 503 on both, nothing created", off.every((s) => s === 503) && (await attemptsOf(x)).length === 0, off);
}
{
  const SIMCLUB = await one("insert into clubs (name, slug, town_id, active, payment_mode, service_fee_usd, is_demo) select 'Sim Club', 'zz-nat-sim', town_id, true, 'simulated', 1, true from clubs where id = $1 returning id", [CLUB]);
  const x = await hold({ club: SIMCLUB, provider: "simulated" });
  const r = await pay(x);
  const s = await look(x);
  rep("N26 a court-and-fee payment (Model 1 demo) is refused by both endpoints: wrong_payment_mode, final", r.status === 409 && r.body.error === "wrong_payment_mode" && r.body.final === true
    && s.status === 409 && (await attemptsOf(x)).length === 0, { r: r.body, s: s.body });
}
{
  const x = await hold();
  const leak = JSON.stringify(reported) + JSON.stringify(gw.starts);
  rep("N27 no access token appears in anything reported or sent to the gateway", ![x.token, ...players.map((p) => tokenFor(p))].some((t) => leak.includes(t.split(".")[2])));
}

console.log("--- F4 lifecycle (the app killed, reopened, account switched)");
{
  const x = await hold();
  const key = randomUUID();
  const r1 = await pay(x, key);
  // the app is killed here; it comes back later with its stored key (a new process, nothing else remembered)
  const r2 = await pay(x, key);
  rep("N28 reopened app retrying with its stored key gets the same page, never a second attempt", r2.body.redirect === r1.body.redirect && (await attemptsOf(x)).length === 1, { r1: r1.body, r2: r2.body });
  gw.pay((await attemptsOf(x))[0].id);
  const s = await look(x);
  rep("N29 reopened app after paying with no callback and no return: status confirms it", s.body.state === "confirmed", s.body);
  const other = players[playerN++];
  const sw = await look(x, tokenFor(other));
  rep("N30 after an account switch the new account's token sees nothing of the old account's payment", sw.status === 404, sw.body);
}
{
  const x = await hold();
  await pay(x);
  const y = await hold({ who: x.who });                // a second hold by the same player expires the first (one hold at a time)
  const s = await look(x);
  rep("N31 a new hold ends the previous one even with its page open: the old one reads checking (never confirmed), the new one awaiting_payment",
    s.body.state === "checking" && (await row(x)).booking === "expired" && (await look(y)).body.state === "awaiting_payment", s.body);
}

console.log(`\n${oks} ok, ${fails} failed`);
await db.end();
process.exit(fails ? 1 : 0);
