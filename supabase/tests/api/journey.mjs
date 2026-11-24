// Booking journey acceptance (Mission 2, 24 Nov), through Supabase's real database API (local PostgREST) with the
// website's and the app's own query shapes. Where the app's own module exists, it is used as is: mobile/lib/reserve.ts
// (retries with one token, "uncertain" when no answer). Every step is also checked in the database itself.
//
//   PSQL="sudo -u postgres psql" bash supabase/tests/run.sh
//   PSQL="sudo -u postgres psql" bash supabase/tests/api/start.sh
//   sudo -u postgres env PG_MODULE=/tmp/pgdeps/node_modules node --experimental-strip-types --no-warnings \
//     --import ./supabase/tests/api/register.mjs supabase/tests/api/journey.mjs
//   bash supabase/tests/api/stop.sh
import { createRequire } from "node:module";
import { API_URL, API_DB, asAnon, asService, asUser } from "./lib.mjs";
import { newAttempt, reserve, findByToken } from "../../../mobile/lib/reserve.ts";
import { STAFF_BOOKING_COLUMNS, settlement, SETTLEMENT_TEXT } from "../../../src/lib/types.ts";
import { paymentsByBooking } from "../../../src/lib/staffPayments.ts";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];
const fault = (f) => fetch(`${API_URL}/__fault`, { method: "POST", body: JSON.stringify(f) });
const section = (s) => console.log(`--- ${s}`);

// ------------------------------------------------------------------ fixtures (a published desk club, players, staff)
const U = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = U(1), P2 = U(2), STAFF = U(3), OTHER_STAFF = U(4);
await q(`insert into auth.users (id, phone) values ($1,'+96171100001'),($2,'+96171100002'),($3,'+96171100003'),($4,'+96171100004') on conflict do nothing`, [P1, P2, STAFF, OTHER_STAFF]);
await q(`update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app', name = case id when $1 then 'Rana' when $2 then 'Karim' else name end where id = any($3)`, [P1, P2, [P1, P2, STAFF, OTHER_STAFF]]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
const OTHER = await one("select id from clubs where slug = 'other'");
await q("insert into club_staff (club_id, profile_id) values ($1,$2),($3,$4) on conflict do nothing", [CLUB, STAFF, OTHER, OTHER_STAFF]);
await q("update clubs set payment_mode = 'at_desk', cancel_cutoff_hours = 6 where id = $1", [CLUB]);
const COURT = await one("insert into courts (club_id, name, sport, sort) values ($1, 'Journey 1', 'padel', 950) returning id", [CLUB]);
const COURT2 = await one("insert into courts (club_id, name, sport, sort) values ($1, 'Journey 2', 'padel', 951) returning id", [CLUB]);
// a club in the same district that is NOT published (hidden): never offered to players
const HIDDEN = await one(`insert into clubs (name, slug, town_id) values ('Hidden Batroun Club', 'zz-hidden-journey', (select town_id from clubs where id = $1)) returning id`, [CLUB]);
await q("insert into courts (club_id, name, sport) values ($1, 'Hidden 1', 'padel')", [HIDDEN]);
const GOV = await one("select d.governorate_code from clubs c join towns t on t.id = c.town_id join districts d on d.code = t.district_code where c.id = $1", [CLUB]);
const DIST = await one("select t.district_code from clubs c join towns t on t.id = c.town_id where c.id = $1", [CLUB]);
const DAY = (d) => one(`select (current_date + ${d})::text`);
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
const D1 = await DAY(4), T10 = await at(4, "10:00"), T11 = await at(4, "11:00"), T12 = await at(4, "12:00"), T13 = await at(4, "13:00");
const iso = (d) => new Date(d).toISOString();

// the same reads each surface makes
const discovery = async (client, date, extra = {}) => {      // website Courts page and app Courts tab (same RPC and arguments)
  const { data, error } = await client.rpc("club_day_slots", { p_date: date, p_sport: "padel", p_governorate: GOV, p_district: DIST, p_query: null, ...extra });
  return { error, rows: data ?? [] };
};
const offered = async (client, date, court, startIso) => (await discovery(client, date)).rows.some((r) => r.court_id === court && iso(r.start_at) === startIso && r.free_minutes >= 60);
const occupancy = async (client) => {                         // club page grid (website PlayerGrid / club page)
  const { data } = await client.from("occupancy").select("id, court_id, start_at, end_at, status, mine, kind").eq("club_id", CLUB).lt("start_at", iso(await at(5, "00:00"))).gt("end_at", iso(await at(4, "00:00")));
  return data ?? [];
};
const busyAt = (occ, court, startIso) => occ.some((o) => o.court_id === court && new Date(o.start_at) <= new Date(startIso) && new Date(o.end_at) > new Date(startIso));
const staffDay = async (client) => {                          // website staff calendar (DayCalendar's own query, contacts, payments)
  const { data, error } = await client.from("bookings").select(STAFF_BOOKING_COLUMNS).eq("club_id", CLUB)
    .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`).not("court_id", "is", null)
    .lt("start_at", iso(await at(5, "00:00"))).gt("end_at", iso(await at(4, "00:00"))).order("start_at");
  if (error) return { error, rows: [] };
  const { data: contacts } = await client.rpc("club_booking_contacts", { p_club: CLUB, p_bookings: data.map((b) => b.id) });
  const by = new Map((contacts ?? []).map((c) => [c.booking_id, c]));
  const rows = await paymentsByBooking(client, data.map((b) => ({ ...b, player_name: by.get(b.id)?.name ?? null, contact_phone: by.get(b.id)?.phone ?? null })));
  return { error: null, rows };
};
const agenda = async (client) => (await client.rpc("my_agenda")).data ?? [];
const row = (id) => q("select b.status, b.source, b.price_usd::float as price, b.fee_usd::float as fee, b.start_at, b.end_at, b.court_id, p.status as payment from bookings b left join payments p on p.booking_id = b.id where b.id = $1", [id]).then((r) => r[0]);
const asApp = (client) => { globalThis.__sb = client; };     // the phone's signed-in client for mobile/lib/*.ts

const anon = asAnon(), p1 = asUser(P1), p2 = asUser(P2), staff = asUser(STAFF), otherStaff = asUser(OTHER_STAFF), service = asService();

// ================================================================== 2A. player journey (desk-payment club)
section("2A player journey at a club that takes payment at its desk");
{
  const { data: areas } = await anon.rpc("areas");
  rep("A1 a new visitor sees the areas (governorate > district) to choose from", Array.isArray(areas) && areas.some((g) => g.code === GOV && g.districts.some((d) => d.code === DIST)));
  const disc = await discovery(anon, D1);
  const clubs = [...new Set(disc.rows.map((r) => r.club_id))];
  rep("A2 choosing the district and padel lists the published club, with free courts", !disc.error && clubs.includes(CLUB), disc.error?.message ?? clubs);
  rep("A3 an unpublished club in the same district is never offered", !clubs.includes(HIDDEN) && !(await anon.from("clubs").select("id").eq("id", HIDDEN)).data?.length);
  const byName = await discovery(anon, D1, { p_governorate: null, p_district: null, p_query: "Batroun" });
  rep("A3b searching by name finds it, still not the hidden one", byName.rows.some((r) => r.club_id === CLUB) && !byName.rows.some((r) => r.club_id === HIDDEN));
  rep("A4 the chosen court is free at 10:00 on the chosen day (discovery and club page agree)", await offered(anon, D1, COURT, iso(T10)) && !busyAt(await occupancy(anon), COURT, iso(T10)));
  const { data: price } = await anon.rpc("quote_price", { p_court: COURT, p_start: iso(T10), p_end: iso(T11) });
  const { data: mode } = await anon.from("clubs").select("payment_mode, service_fee_usd").eq("id", CLUB).single();
  rep("A5 the price and how to pay are shown: the club's price, paid at the desk", Number(price) > 0 && mode?.payment_mode === "at_desk", { price, mode });

  asApp(p1);
  const attempt = newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(T10), end: new Date(T11) });
  const r = await reserve(attempt);
  const b = r.kind === "reserved" ? await row(r.value.bookingId) : null;
  rep("A6 the player books (the app's own reserve()): confirmed at once", r.kind === "reserved" && r.value.confirmed && b?.status === "confirmed", r);
  rep("A7 in the database: an app booking, the club's price, no CourtBook fee, no CourtBook payment", b?.source === "app" && b.price === Number(price) && b.fee === 0 && b.payment === null, b);
  const sd = await staffDay(staff);
  const sb = sd.rows.find((x) => x.id === r.value?.bookingId);
  rep("A8 the club's calendar shows it, with the player's name, to be paid at the desk", !!sb && sb.player_name === "Rana" && settlement(sb) === "at_desk" && SETTLEMENT_TEXT[settlement(sb)].startsWith("take payment at the desk"), sd.error?.message ?? sb);
  rep("A9 availability updates everywhere: not offered in discovery, busy on the club page", !(await offered(anon, D1, COURT, iso(T10))) && busyAt(await occupancy(anon), COURT, iso(T10)));
  asApp(p2);
  const r2 = await reserve(newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(T10), end: new Date(T11) }));
  rep("A10 another player cannot book the same slot: a named refusal, nothing created", r2.kind === "refused" && /taken/i.test(r2.failure.message) && Number(await one("select count(*) from bookings where court_id = $1 and status in ('confirmed','pending')", [COURT])) === 1, r2);
  const ag = await agenda(p1);
  rep("A11 the player's bookings list shows it", ag.some((x) => x.id === r.value?.bookingId && x.status === "confirmed"));
  const cx = await p1.rpc("cancel_booking", { p_booking: r.value.bookingId });
  rep("A12 the player cancels: cancelled in the database", !cx.error && (await row(r.value.bookingId)).status === "cancelled", cx.error?.message);
  rep("A13 the time is offered again, and the club page shows it free", await offered(anon, D1, COURT, iso(T10)) && !busyAt(await occupancy(anon), COURT, iso(T10)));
  rep("A14 the club's calendar no longer shows it", !(await staffDay(staff)).rows.some((x) => x.id === r.value.bookingId));
  const again = await reserve(newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(T10), end: new Date(T11) }));
  rep("A15 ...and the other player can now book it", again.kind === "reserved", again);
  await p2.rpc("cancel_booking", { p_booking: again.value?.bookingId });
}

// ================================================================== 2B. hold and payment states (in-app payment club)
section("2B holds and payment states (in-app payment, simulated provider)");
await q("update clubs set payment_mode = 'simulated' where id = $1", [CLUB]);
const D2 = await DAY(5), H = async (hhmm) => at(5, hhmm);
const hold = async (client, court, s, e) => { asApp(client); return reserve(newAttempt({ mode: "simulated", clubId: CLUB, courtId: court, start: new Date(s), end: new Date(e) })); };
const confirm = (paymentId, ref, total) => service.rpc("confirm_payment", { p_payment: paymentId, p_provider_ref: ref, p_total_usd: total });
const pay = async (bookingId) => (await q("select id, total_usd from payments where booking_id = $1", [bookingId]))[0];
const expire = (bookingId) => q("update bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [bookingId]);
const moneyWithoutBooking = () => one(`select count(*)::int from payments p join bookings b on b.id = p.booking_id
  where p.status = 'paid' and b.status not in ('confirmed','no_show','cancelled')`);
{
  let s = await H("09:00"), e = await H("10:00");
  const ok1 = await hold(p1, COURT, s, e);
  const p = await pay(ok1.value.bookingId);
  rep("B1 a hold is pending with a pending payment; the slot is held", (await row(ok1.value.bookingId)).status === "pending" && (await row(ok1.value.bookingId)).payment === "pending" && !(await offered(anon, D2, COURT, iso(s))));
  const c1 = await confirm(p.id, "sim-ok-1", p.total_usd);
  const after = await row(ok1.value.bookingId);
  rep("B1 normal confirmation: booking confirmed, payment paid, calendar says 'paid in the app'", c1.data === "confirmed" && after.status === "confirmed" && after.payment === "paid"
    && settlement((await staffDay(staff)).rows.find((x) => x.id === ok1.value.bookingId) ?? {}) === "paid_in_app", { c1, after });
  const dup = await confirm(p.id, "sim-ok-1", p.total_usd);
  rep("B2 a duplicate callback (same receipt) answers already_paid and changes nothing", dup.data === "already_paid" && (await row(ok1.value.bookingId)).payment === "paid");
  const other = await confirm(p.id, "sim-ok-2", p.total_usd);
  rep("B3 a second, different receipt for the same payment is refused (payment_mismatch): investigate, no double charge recorded", /payment_mismatch/.test(other.error?.message ?? ""), other);

  s = await H("10:00"); e = await H("11:00");
  const f = await hold(p1, COURT, s, e);
  const fp = await pay(f.value.bookingId);
  const failed = await service.rpc("fail_payment", { p_payment: fp.id, p_note: "card declined" });
  rep("B4 payment failure: booking expired, payment failed, the slot is free again at once", !failed.error && (await row(f.value.bookingId)).status === "expired" && (await row(f.value.bookingId)).payment === "failed" && await offered(anon, D2, COURT, iso(s)));

  s = await H("11:00"); e = await H("12:00");
  const ab = await hold(p1, COURT, s, e);
  const rel = await p1.rpc("release_hold", { p_booking: ab.value.bookingId });
  rep("B5 abandoned payment (Back / cancel): the hold is released, payment expired, slot free", !rel.error && (await row(ab.value.bookingId)).status === "expired" && (await row(ab.value.bookingId)).payment === "expired" && await offered(anon, D2, COURT, iso(s)));

  s = await H("12:00"); e = await H("13:00");
  const ex = await hold(p1, COURT, s, e);
  await expire(ex.value.bookingId);
  rep("B6 an expired hold no longer blocks the slot for others (discovery offers it, club page free)", await offered(anon, D2, COURT, iso(s)) && !busyAt((await anon.from("occupancy").select("court_id,start_at,end_at").eq("club_id", CLUB)).data ?? [], COURT, iso(s)));
  const exp = await pay(ex.value.bookingId);
  const late = await confirm(exp.id, "sim-late-free", exp.total_usd);
  rep("B7 payment after the hold expired, slot still free: the booking is confirmed (0090)", late.data === "confirmed" && (await row(ex.value.bookingId)).status === "confirmed", late);

  s = await H("13:00"); e = await H("14:00");
  const lost = await hold(p1, COURT, s, e);
  await expire(lost.value.bookingId);
  const taker = await hold(p2, COURT, s, e);
  const lp = await pay(lost.value.bookingId);
  const late2 = await confirm(lp.id, "sim-late-taken", lp.total_usd);
  const lr = await row(lost.value.bookingId);
  rep("B8 payment after another player took the slot: no booking for it, the money is owed back (refund_due)", taker.kind === "reserved" && late2.data === "refund_due" && lr.status === "expired" && lr.payment === "refund_due", { late2, lr });
  rep("B8 ...the other player keeps the slot", (await row(taker.value.bookingId)).status === "pending");

  s = await H("15:00"); e = await H("16:00");
  const cc = await hold(p1, COURT, s, e);
  const cp = await pay(cc.value.bookingId);
  await p1.rpc("cancel_booking", { p_booking: cc.value.bookingId });
  const afterCancel = await confirm(cp.id, "sim-cancelled", cp.total_usd);
  rep("B9 cancellation while paying, then the payment lands: no booking, money owed back", afterCancel.data === "refund_due" && (await row(cc.value.bookingId)).status === "cancelled" && (await row(cc.value.bookingId)).payment === "refund_due", afterCancel);

  s = await H("16:00"); e = await H("17:00");
  const bh = await hold(p1, COURT2, s, e);
  await expire(bh.value.bookingId);
  const blk = await staff.rpc("staff_block", { p_club: CLUB, p_court: COURT2, p_start: iso(s), p_end: iso(e), p_reason: "Repair" });
  const bp = await pay(bh.value.bookingId);
  const lateBlocked = await confirm(bp.id, "sim-blocked", bp.total_usd);
  rep("B10 a staff block over an expired hold: the block wins, a late payment is owed back", !blk.error && lateBlocked.data === "refund_due" && (await row(bh.value.bookingId)).status === "expired", { blk: blk.error?.message, lateBlocked });

  s = await H("18:00"); e = await H("19:00");
  const { data: wid } = await staff.rpc("staff_book", { p_club: CLUB, p_court: COURT2, p_start: iso(await H("20:00")), p_end: iso(await H("21:00")), p_name: "Move Me", p_phone: null });
  const mq = await staff.rpc("quote_move", { p_booking: wid, p_court: COURT2, p_start: iso(s), p_end: iso(e) });
  const mv = await staff.rpc("move_booking_priced", { p_booking: wid, p_court: COURT2, p_start: iso(s), p_end: iso(e), p_expected_price: mq.data?.new });
  const compete = await hold(p2, COURT2, s, e);
  rep("B11 a booking moved into a slot, then a player tries it: the move holds, the player is refused", !mv.error && compete.kind === "refused", { mv: mv.error?.message, compete });

  // network: the hold reaches the database but the phone never gets the answer
  s = await H("08:00"); e = await H("09:00");
  await fault({ match: "rpc/hold_slot", mode: "lose_response", count: 1 });
  const net = await hold(p1, COURT2, s, e);
  const n1 = Number(await one("select count(*) from bookings where player_id = $1 and court_id = $2 and start_at = $3", [P1, COURT2, s]));
  rep("B12 the answer is lost after the database committed: the app retries with the same token and gets the SAME booking (no duplicate)", net.kind === "reserved" && net.value.already === true && n1 === 1, { net, n1 });
  await fault({ match: "rpc/hold_slot", mode: "lose_response", count: 3 });
  s = await H("21:00"); e = await H("22:00");
  asApp(p1);
  const unk = newAttempt({ mode: "simulated", clubId: CLUB, courtId: COURT, start: new Date(s), end: new Date(e) });
  const u = await reserve(unk);
  const look = await findByToken(unk.token);
  const n2 = Number(await one("select count(*) from bookings where client_token = $1", [unk.token]));
  rep("B13 no answer at all: the app says 'uncertain' (never 'failed'), then finds the one booking by its token", u.kind === "uncertain" && look.kind === "found" && n2 === 1, { u: u.kind, look, n2 });
  await fault({ match: "rpc/book_at_desk", mode: "no_connection", count: 1 });
  await fault({ clear: true });
  rep("B14 never: money taken without a booking or a refund owed (whole database)", (await moneyWithoutBooking()) === 0);
}

// ================================================================== 2C. staff journey (phone, WhatsApp, walk-in)
section("2C staff bookings: phone, WhatsApp, walk-in");
await q("update clubs set payment_mode = 'at_desk' where id = $1", [CLUB]);
const D3 = await DAY(6), S = (hhmm) => at(6, hhmm);
{
  const made = {};
  for (const [label, name, phone, start] of [["phone", "Phone: Elie", "03 111 222", "10:00"], ["WhatsApp", "WhatsApp: Maya", "70 333 444", "12:00"], ["walk-in", "Walk-in", null, "14:00"]]) {
    const s = await S(start), e = new Date(new Date(s).getTime() + 3600e3);
    const r = await staff.rpc("staff_book", { p_club: CLUB, p_court: COURT, p_start: iso(s), p_end: iso(e), p_name: name, p_phone: phone });
    const b = r.data ? await row(r.data) : null;
    made[label] = { id: r.data, s, e };
    rep(`C1 a ${label} booking is committed: confirmed, the club's price, NO CourtBook fee, no payment`, !r.error && b?.status === "confirmed" && b.source === "staff" && b.fee === 0 && b.payment === null && b.price > 0, r.error?.message ?? b);
    rep(`C2 ...player-facing availability changes at once (discovery and club page)`, !(await offered(anon, D3, COURT, iso(s))) && busyAt(((await anon.from("occupancy").select("court_id,start_at,end_at").eq("club_id", CLUB)).data ?? []), COURT, iso(s)));
    asApp(p1);
    const tryIt = await reserve(newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(s), end: e }));
    rep(`C3 ...and a player cannot reserve that time`, tryIt.kind === "refused", tryIt);
  }
  const w = made["walk-in"];
  const longer = new Date(new Date(w.s).getTime() + 2 * 3600e3);
  const qd = await staff.rpc("quote_move", { p_booking: w.id, p_court: COURT, p_start: iso(w.s), p_end: iso(longer) });
  rep("C4 extending the walk-in to 2 h: the new price is shown first (old → new)", qd.data?.kind === "reprice" && Number(qd.data.new) === 2 * Number(qd.data.current), qd.data);
  const silent = await staff.rpc("move_booking", { p_booking: w.id, p_court: COURT, p_start: iso(w.s), p_end: iso(longer) });
  rep("C5 ...it cannot change without that confirmation", /price_confirmation_needed/.test(silent.error?.message ?? ""), silent.error?.message);
  const ext = await staff.rpc("move_booking_priced", { p_booking: w.id, p_court: COURT, p_start: iso(w.s), p_end: iso(longer), p_expected_price: qd.data.new });
  rep("C6 confirmed: 2 h at the new price, still no fee", !ext.error && (await row(w.id)).price === Number(qd.data.new) && (await row(w.id)).fee === 0, ext.error?.message);
  const to = await S("17:00"), toEnd = new Date(new Date(to).getTime() + 2 * 3600e3);
  const mq = await staff.rpc("quote_move", { p_booking: w.id, p_court: COURT2, p_start: iso(to), p_end: iso(toEnd) });
  const mv = await staff.rpc("move_booking_priced", { p_booking: w.id, p_court: COURT2, p_start: iso(to), p_end: iso(toEnd), p_expected_price: mq.data?.new });
  const cal = (await staffDayFor(6)).find((x) => x.id === w.id);
  rep("C7 moved to another court and time: the calendar shows the new court and time", !mv.error && cal && cal.court_id === COURT2 && iso(cal.start_at) === iso(to), mv.error?.message ?? cal);
  rep("C8 ...the old time is free again for players, the new one is taken", await offered(anon, D3, COURT, iso(w.s)) && !(await offered(anon, D3, COURT2, iso(to))));
  const xq = await otherStaff.rpc("quote_move", { p_booking: w.id, p_court: COURT2, p_start: iso(to), p_end: iso(toEnd) });
  rep("C9 another club's desk can neither see the price nor move it", /forbidden/.test(xq.error?.message ?? ""));
  const cancel = await staff.rpc("cancel_booking", { p_booking: w.id });
  rep("C10 the desk cancels: cancelled, gone from the calendar, free for players", !cancel.error && (await row(w.id)).status === "cancelled" && !(await staffDayFor(6)).some((x) => x.id === w.id) && await offered(anon, D3, COURT2, iso(to)));
  rep("C11 no staff booking anywhere carries a CourtBook fee or payment (whole database)",
    Number(await one("select count(*) from bookings b where b.source = 'staff' and (b.fee_usd <> 0 or exists (select 1 from payments p where p.booking_id = b.id))")) === 0);
}
async function staffDayFor(d) {
  const { data } = await staff.from("bookings").select(STAFF_BOOKING_COLUMNS).eq("club_id", CLUB)
    .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`).not("court_id", "is", null)
    .lt("start_at", iso(await at(d + 1, "00:00"))).gt("end_at", iso(await at(d, "00:00")));
  return data ?? [];
}

// ================================================================== 2D. cross-surface consistency
section("2D the same reservation seen from every surface");
{
  const s = await at(7, "18:00"), e = await at(7, "19:00"), D = await DAY(7);
  const before = await discovery(anon, D);                                  // a page loaded before the booking (stale)
  rep("D1 before: free in website/app discovery, on the club page, in the calendar", before.rows.some((r) => r.court_id === COURT && iso(r.start_at) === iso(s))
    && !busyAt(((await anon.from("occupancy").select("court_id,start_at,end_at").eq("club_id", CLUB)).data ?? []), COURT, iso(s)) && !(await staffDayFor(7)).some((x) => x.court_id === COURT && iso(x.start_at) === iso(s)));
  asApp(p2);
  const r = await reserve(newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(s), end: new Date(e) }));
  const views = {
    discovery_web: !(await offered(anon, D, COURT, iso(s))),
    discovery_app_signed_in: !(await offered(p1, D, COURT, iso(s))),
    club_page: busyAt(((await p1.from("occupancy").select("court_id,start_at,end_at").eq("club_id", CLUB)).data ?? []), COURT, iso(s)),
    staff_calendar: (await staffDayFor(7)).some((x) => x.id === r.value?.bookingId && x.status === "confirmed"),
    booker_agenda: (await agenda(p2)).some((x) => x.id === r.value?.bookingId && x.status === "confirmed"),
    database: (await row(r.value.bookingId)).status === "confirmed",
  };
  rep("D2 after: every surface agrees it is taken (none shows it free while another shows it confirmed)", Object.values(views).every(Boolean), views);
  asApp(p1);
  const stale = await reserve(newAttempt({ mode: "at_desk", clubId: CLUB, courtId: COURT, start: new Date(s), end: new Date(e) }));
  rep("D3 a player acting on the stale page (loaded before) is refused by the server, not double-booked", stale.kind === "refused" && Number(await one("select count(*) from bookings where court_id = $1 and start_at = $2 and status in ('confirmed','pending')", [COURT, s])) === 1, stale);
  rep("D4 a refresh shows it taken", !(await offered(anon, D, COURT, iso(s))));
  const occ = (await p2.from("occupancy").select("id, mine, court_id, start_at").eq("club_id", CLUB)).data ?? [];
  const occOther = (await p1.from("occupancy").select("id, mine, court_id, start_at").eq("club_id", CLUB)).data ?? [];
  rep("D5 the club page shows the booker it is theirs; others see only 'busy', never who or which booking", occ.some((o) => o.id === r.value.bookingId && o.mine) && occOther.filter((o) => o.court_id === COURT && iso(o.start_at) === iso(s)).every((o) => o.id === null && !o.mine));
  const cx = await p2.rpc("cancel_booking", { p_booking: r.value.bookingId });
  const viewsAfter = {
    discovery: await offered(anon, D, COURT, iso(s)),
    club_page: !busyAt(((await p1.from("occupancy").select("court_id,start_at,end_at").eq("club_id", CLUB)).data ?? []), COURT, iso(s)),
    staff_calendar: !(await staffDayFor(7)).some((x) => x.id === r.value.bookingId),
    agenda_status: (await agenda(p2)).find((x) => x.id === r.value.bookingId)?.status !== "confirmed",
  };
  rep("D6 after cancelling: every surface agrees it is free / cancelled", !cx.error && Object.values(viewsAfter).every(Boolean), viewsAfter);
  const othersCal = (await otherStaff.from("bookings").select("id").eq("club_id", CLUB)).data ?? [];
  const playerCal = (await p1.from("bookings").select("id").eq("club_id", CLUB)).data ?? [];
  const notMine = playerCal.length ? Number(await one("select count(*) from bookings where id = any($1) and player_id is distinct from $2", [playerCal.map((b) => b.id), P1])) : 0;
  const allAtClub = Number(await one("select count(*) from bookings where club_id = $1", [CLUB]));
  rep("D7 another club's desk sees none of this club's bookings; a player reads only their own", othersCal.length === 0 && notMine === 0 && playerCal.length < allAtClub, { others: othersCal.length, notMine, mine: playerCal.length, allAtClub });
}

console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
await db.end();
process.exit(fails ? 1 : 0);
