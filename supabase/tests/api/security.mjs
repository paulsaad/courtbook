// Targeted security and privacy checks (Mission 5C, 24 Nov) through Supabase's real database API (local PostgREST),
// as a visitor, as one player against another, and as a player calling staff or server functions. Every refusal is
// also confirmed in the database (nothing changed). LOCAL ONLY: run with security.sh.
import { createRequire } from "node:module";
import { API_URL, API_DB, ANON_KEY, asAnon, asUser } from "./lib.mjs";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);

let oks = 0, fails = 0;
const rep = (name, cond, detail = "") => { if (cond) { oks++; console.log(`ok    ${name}`); } else { fails++; console.log(`FAIL  ${name}  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`); } };
const db = new Client({ connectionString: `postgresql:///${API_DB}?host=/var/run/postgresql` }); await db.connect();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => Object.values((await q(sql, args))[0] ?? {})[0];
/** refused = an error, or an answer with none of the protected rows */
const none = (r, pick = () => true) => !!r.error || (r.data ?? []).filter(pick).length === 0;

const U = (n) => `5c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = U(1), B = U(2), DESK = U(3);
await q(`insert into auth.users (id, phone) values ($1,'+96171500001'),($2,'+96171500002'),($3,'+96171500003') on conflict do nothing`, [A, B, DESK]);
await q(`update profiles set rules_accepted_at = now(), age_confirmed_at = now(), age_confirmed_via = 'app', name = case id when $1 then 'Alia' when $2 then 'Bassel' else 'Desk' end where id = any($3)`, [A, B, [A, B, DESK]]);
const CLUB = await one("select id from clubs where slug = 'batroun'");
const OTHER = await one("select id from clubs where slug = 'other'");
await q("insert into club_staff (club_id, profile_id) values ($1,$2) on conflict do nothing", [CLUB, DESK]);
const COURT = await one("insert into courts (club_id, name, sport, sort) values ($1, 'Sec 1', 'padel', 960) returning id", [CLUB]);
const at = (d, hhmm) => one(`select (((current_date + ${d})::timestamp + $1::time) at time zone 'Asia/Beirut')`, [hhmm]);
const T = [await at(4, "10:00"), await at(4, "11:00")];
// B's private things: a booking (with a guest phone on a desk booking too), areas, a favourite, prefs
const BB = await one(`insert into bookings (club_id, court_id, player_id, start_at, end_at, status, source, created_by, price_usd, fee_usd)
  values ($1,$2,$3,$4,$5,'confirmed','app',$3,20,0) returning id`, [CLUB, COURT, B, T[0], T[1]]);
await q(`insert into bookings (club_id, court_id, start_at, end_at, status, source, created_by, price_usd, fee_usd, guest_name, guest_phone)
  values ($1,$2,$3,$4,'confirmed','staff',$5,20,0,'Phone: Secret','03 999 999')`, [CLUB, COURT, await at(4, "12:00"), await at(4, "13:00"), DESK]);
await q("insert into club_favourites (profile_id, club_id) values ($1,$2) on conflict do nothing", [B, CLUB]);
await q("insert into player_areas (profile_id, position, governorate_code) values ($1, 1, 'north') on conflict do nothing", [B]);
await q("insert into player_prefs (profile_id, areas_asked_at, last_governorate) values ($1, now(), 'north') on conflict (profile_id) do update set last_governorate = 'north'", [B]);
const HIDDEN = await one(`insert into clubs (name, slug, town_id, active) values ('Hidden Sec Club', 'zz-hidden-sec', (select town_id from clubs where id = $1), false) returning id`, [CLUB]);

const anon = asAnon(), a = asUser(A), desk = asUser(DESK);
console.log("--- visitors");
for (const t of ["bookings", "payments", "profiles", "player_areas", "club_favourites", "player_prefs", "account_deletions", "club_staff"]) {
  const r = await anon.from(t).select("*").limit(5);
  rep(`S1 a visitor reads nothing from ${t}`, none(r), r.error?.message ?? `${r.data?.length} rows`);
}
const occ = await anon.from("public_occupancy").select("*").limit(50);
rep("S2 the public availability view carries no player, guest or booking identity", !occ.error && (occ.data ?? []).every((r) => !Object.keys(r).some((k) => /player|guest|phone|name|booking_id|profile/.test(k))), occ.error?.message ?? Object.keys(occ.data?.[0] ?? {}).join(","));
const hid = await anon.from("clubs").select("id").eq("id", HIDDEN);
rep("S3 an unpublished club is not readable by a visitor", none(hid), hid.error?.message ?? `${hid.data?.length}`);

console.log("--- one player against another");
const rb = await a.from("bookings").select("id, guest_phone").in("id", [BB]);
rep("S4 a player cannot read another player's booking", none(rb), rb.error?.message ?? JSON.stringify(rb.data));
const gp = await a.from("bookings").select("guest_phone").not("guest_phone", "is", null);
rep("S5 a player cannot read phone numbers the desk typed in", none(gp), gp.error?.message ?? JSON.stringify(gp.data));
const pp = await a.from("profiles").select("id, phone").eq("id", B);
rep("S6 a player cannot read another player's phone number", none(pp, (r) => r.phone != null), pp.error?.message ?? JSON.stringify(pp.data));
for (const t of ["player_areas", "club_favourites", "player_prefs"]) {
  const r = await a.from(t).select("*").eq("profile_id", B);
  rep(`S7 a player cannot read another player's ${t}`, none(r), r.error?.message ?? JSON.stringify(r.data));
}
await a.from("club_favourites").insert({ profile_id: B, club_id: OTHER });
await a.from("player_areas").insert({ profile_id: B, position: 2, governorate_code: "beirut" });
rep("S8 a player cannot add favourites or areas to another account", (await one("select count(*)::int from club_favourites where profile_id = $1", [B])) === 1 && (await one("select count(*)::int from player_areas where profile_id = $1", [B])) === 1);
await a.from("bookings").update({ status: "cancelled" }).eq("id", BB);
await a.from("bookings").delete().eq("id", BB);
rep("S9 a player cannot cancel or delete another player's booking directly", (await one("select status from bookings where id = $1", [BB])) === "confirmed");
const cx = await a.rpc("cancel_booking", { p_booking: BB, p_club_caused: false });
rep("S10 ...nor through cancel_booking", !!cx.error && (await one("select status from bookings where id = $1", [BB])) === "confirmed", cx.error?.message ?? "no error");

console.log("--- a player reaching for staff, admin or server powers");
await a.from("profiles").update({ roles: ["admin"] }).eq("id", A);
rep("S11 a player cannot make themselves an admin", !(await one("select 'admin' = any(roles) from profiles where id = $1", [A])));
await a.from("club_staff").insert({ club_id: CLUB, profile_id: A });
rep("S12 a player cannot make themselves club staff", (await one("select count(*)::int from club_staff where profile_id = $1", [A])) === 0);
const clubBefore = await one("select service_fee_usd::text || '/' || payment_mode from clubs where id = $1", [CLUB]);
await a.from("clubs").update({ service_fee_usd: 0.01, payment_mode: "simulated" }).eq("id", CLUB);
const clubAfter = await one("select service_fee_usd::text || '/' || payment_mode from clubs where id = $1", [CLUB]);
rep("S13 a player cannot change a club's fee or payment mode", clubAfter === clubBefore && !clubAfter.startsWith("0.01"), `${clubBefore} → ${clubAfter}`);
const ins = await a.from("bookings").insert({ club_id: CLUB, court_id: COURT, player_id: A, start_at: await at(5, "10:00"), end_at: await at(5, "11:00"), status: "confirmed", source: "app", created_by: A });
rep("S14 a player cannot write a confirmed booking directly (only through the booking functions)", !!ins.error && (await one("select count(*)::int from bookings where player_id = $1", [A])) === 0, ins.error?.message ?? "inserted");
const calls = [
  ["confirm_payment", { p_payment: BB, p_provider_ref: "x", p_total_usd: 1 }], ["fail_payment", { p_payment: BB, p_note: "x" }],
  ["mark_refunded", { p_payment: BB }], ["staff_book", { p_club: CLUB, p_court: COURT, p_start: await at(6, "10:00"), p_end: await at(6, "11:00"), p_name: "X", p_phone: null }],
  ["club_booking_contacts", { p_club: CLUB, p_ids: [BB] }], ["set_club_payment_mode", { p_club: CLUB, p_mode: "simulated" }],
  ["set_club_base_prices", { p_club: CLUB, p_base: 1, p_peaks: [], p_replace: true }],
];
for (const [fn, args] of calls) {
  const r = await a.rpc(fn, args);
  const leaked = fn === "club_booking_contacts" && Array.isArray(r.data) && r.data.length > 0;
  rep(`S15 a player calling ${fn} is refused`, (!!r.error || (fn === "club_booking_contacts" && !leaked)) && !leaked, r.error?.message ?? JSON.stringify(r.data));
}
rep("S15b ...and nothing changed: no staff booking at 10:00 day 6, prices and mode untouched",
  (await one("select count(*)::int from bookings where court_id = $1 and start_at = $2", [COURT, await at(6, "10:00")])) === 0
  && (await one("select count(*)::int from price_rules where club_id = $1 and price_usd = 1", [CLUB])) === 0);
const od = await desk.rpc("club_booking_contacts", { p_club: OTHER, p_ids: [BB] });
rep("S16 a desk of one club cannot read another club's contacts", !!od.error || (od.data ?? []).length === 0, od.error?.message ?? JSON.stringify(od.data));

console.log("--- tokens");
const forged = (() => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" }), pay = b64({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 600 });
  return `${head}.${pay}.${createHmac("sha256", "not-the-secret-not-the-secret-not-the-secret").update(`${head}.${pay}`).digest("base64url")}`;
})();
const fr = await createClient(API_URL, ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${forged}` } } }).from("payments").select("id").limit(1);
rep("S17 a token signed with another secret is rejected (no service-role access)", !!fr.error, fr.error?.message ?? "accepted");
const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.`;
const ur = await createClient(API_URL, ANON_KEY, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${unsigned}` } } }).from("payments").select("id").limit(1);
rep("S18 an unsigned token is rejected", !!ur.error, ur.error?.message ?? "accepted");

await db.end();
console.log(`\nsummary: ${oks} ok, ${fails} FAIL`);
console.log(fails ? "RESULT: FAIL" : "RESULT: PASS");
process.exit(fails ? 1 : 0);
