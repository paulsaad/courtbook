// An unresolved reservation left by an earlier run of the app (stored on the phone), the database
// unreachable: Home and another club's screen must show it, offer "Check now", and refuse a new
// reservation. Screenshots go to $SHOTS.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.WEBOUT ?? "/tmp/courtbook-webout";
const SHOTS = process.env.SHOTS ?? "/tmp";
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "index.html");
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".ttf") ? "font/ttf" : "text/html" });
  fs.createReadStream(f).pipe(res);
}).listen(8099);

const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "t@courtbook.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 360000, expires_at: Math.floor(Date.now() / 1000) + 360000, user };
const day = new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 10);
const pending = {
  v: 1, userId: user.id, token: "tok-left-behind", mode: "at_desk", clubId: "club-1", courtId: "court-1",
  start: `${day}T16:30:00.000Z`, end: `${day}T18:00:00.000Z`, quietAfter: 0,
  sel: { key: `court-1|${day}T16:30:00.000Z|90`, mode: "at_desk", clubId: "club-1", clubName: "Batroun Padel & Tennis Club", timezone: "Asia/Beirut",
    courtId: "court-1", courtName: "Padel 1", date: day, start: `${day}T16:30:00.000Z`, minutes: 90, price: 45 },
};
const slots = [];
for (let h = 8; h < 22; h++) slots.push({
  club_id: "club-2", club_name: "Tripoli Sports Club", slug: "tripoli", town: "Tripoli", district: "Tripoli", price_from: 20, sports: ["padel"],
  slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut",
  court_id: "k1", court_name: "Padel A", court_sport: "padel", start_at: `${day}T${String(h - 2).padStart(2, "0")}:00:00+00:00`, free_minutes: 120, is_demo: false,
});

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let failures = 0;
for (const [w, h] of [[375, 667], [393, 852]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await ctx.addInitScript(([sess, p]) => {
    localStorage.setItem("sb-fakeproj-auth-token", JSON.stringify(sess));
    localStorage.setItem(`courtbook.pending-reservation.v1.${p.userId}`, JSON.stringify(p));
  }, [session, pending]);
  const page = await ctx.newPage();
  const sent = [];
  await page.route("https://fakeproj.supabase.co/**", (route) => {
    const url = route.request().url();
    if (url.includes("/rpc/book_at_desk") || url.includes("/rpc/hold_slot")) { sent.push(url); return route.fulfill({ status: 500, json: {} }); }
    if (url.includes("/rest/v1/bookings")) return route.abort("connectionfailed"); // the lookup gets no answer
    if (url.includes("/auth/v1/user")) return route.fulfill({ json: user });
    if (url.includes("/rpc/club_day_slots")) return route.fulfill({ json: slots });
    if (url.includes("/rpc/quote_price")) return route.fulfill({ json: 30 });
    if (url.includes("/rest/v1/clubs")) return route.fulfill({ json: url.includes("description") ? null : { payment_mode: "at_desk" } });
    return route.fulfill({ json: [] });
  });
  await page.goto("http://localhost:8099/");
  await page.getByText("Booking not confirmed yet").waitFor({ timeout: 20000 });
  // The lookup gets no answer: the banner must come back to "Check now", still unresolved.
  await page.getByRole("button", { name: "Check now" }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/pending-home-${w}.png` });
  const home = await page.evaluate(() => document.body.innerText);
  const okHome = home.includes("Batroun Padel & Tennis Club") && home.includes("Check now") && home.includes("couldn't confirm");

  await page.goto(`http://localhost:8099/club/club-2?name=Tripoli&date=${day}`);
  await page.getByLabel(/^1\d:00/).first().waitFor({ timeout: 20000 });
  await page.getByLabel(/^1\d:00/).first().click();
  await page.waitForTimeout(800);
  const btn = page.getByRole("button", { name: "Earlier booking not confirmed" });
  const disabled = (await btn.count()) > 0 && (await btn.getAttribute("aria-disabled")) === "true";
  await btn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/pending-other-club-${w}.png` });
  const other = await page.evaluate(() => document.body.innerText);
  const okOther = disabled && other.includes("Booking not confirmed yet") && sent.length === 0;
  console.log(`${w}x${h}: Home banner ${okHome ? "OK" : "MISSING"}; other club ${okOther ? "blocked, nothing sent" : `NOT BLOCKED (disabled=${disabled}, sent=${sent.length})`}`);
  if (!okHome || !okOther) failures++;
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
