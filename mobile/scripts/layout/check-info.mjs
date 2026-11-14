// Renders the club's Info tab at phone sizes with faked Supabase answers: with and without a cover
// photo, a full club and a sparse one. Checks nothing runs off the side of the screen and every
// section the club filled in is there; screenshots go to $SHOTS for a look.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.WEBOUT ?? "/tmp/courtbook-webout";
const SHOTS = process.env.SHOTS ?? "/tmp";
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  let f = path.join(ROOT, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "index.html");
  const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".html") ? "text/html" : f.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(f).pipe(res);
}).listen(8099);

const full = {
  id: "club-1", name: "Batroun Padel & Tennis Club", timezone: "Asia/Beirut", open_time: "08:00:00", close_time: "23:00:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 120, cancel_cutoff_hours: 6, booking_window_days: 14,
  service_fee_usd: "1.00", payment_mode: "at_desk", location_url: null, lat: "34.255000", lng: "35.660000",
  description: "Four padel courts and two clay tennis courts five minutes from the old souk. Floodlit every evening, with a terrace café overlooking the sea.",
  arrival_notes: "Park in the lot behind the club. The entrance is the green gate on the left.",
  address: "Main road, near Batroun old souk", cover_url: "/storage/v1/object/public/club-media/club-1/cover.webp", is_demo: true,
  has_parking: true, has_changing_rooms: true, has_showers: false, has_equipment_rental: true, has_cafe: true, has_floodlights: true, has_drinking_water: null,
  town: { name_en: "Batroun" },
};
const courts = [
  { id: "k1", name: "Padel 1", sport: "padel", surface: "artificial grass" },
  { id: "k2", name: "Padel 2", sport: "padel", surface: "artificial grass" },
  { id: "k3", name: "Tennis 1", sport: "tennis", surface: "clay" },
  { id: "k4", name: "Pitch 1", sport: "football", surface: null },
];
const rules = [
  { start_time: "08:00:00", end_time: "17:00:00", price_usd: "20.00", label: "Day", court_id: null },
  { start_time: "17:00:00", end_time: "23:00:00", price_usd: "30.00", label: "Evening", court_id: null },
  { start_time: "17:00:00", end_time: "23:00:00", price_usd: "34.00", label: null, court_id: "k2" },
];
const gallery = [
  { id: "g1", kind: "gallery", path: "club-1/g1.webp", external_url: null, caption: "Padel 1 at sunset", sort: 0, width: 1600, height: 1066 },
  { id: "g2", kind: "gallery", path: "club-1/g2.webp", external_url: null, caption: null, sort: 1, width: 1600, height: 1066 },
];
const sparse = { ...full, description: null, arrival_notes: null, address: null, cover_url: null, lat: null, lng: null,
  has_parking: null, has_changing_rooms: null, has_showers: null, has_equipment_rental: null, has_cafe: null, has_floodlights: null, has_drinking_water: null };

const photo = fs.readFileSync(process.env.PHOTO ?? "/tmp/courtbook-photo.png");
const cases = [
  { name: "full, iPhone 15", w: 393, h: 852, club: full, gallery, expect: ["About", "Getting there", "Facilities", "Courts", "Prices per hour", "Booking", "Directions", "Demo club"] },
  { name: "full, iPhone SE", w: 375, h: 667, club: full, gallery, expect: ["About", "Facilities", "Prices per hour"] },
  { name: "full, iPhone SE text 140%", w: 375, h: 667, zoom: 1.4, club: full, gallery, expect: ["About", "Booking"] },
  { name: "sparse, iPhone 15", w: 393, h: 852, club: sparse, gallery: [], expect: ["Courts", "Prices per hour", "Booking"], absent: ["About", "Getting there", "Facilities", "Directions"] },
];

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let failures = 0;
for (const c of cases) {
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.route("https://fakeproj.supabase.co/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/storage/v1/object/public/")) return route.fulfill({ body: photo, contentType: "image/png" });
    if (url.includes("/rpc/club_day_slots")) return route.fulfill({ json: [] });
    if (url.includes("/rest/v1/clubs")) return route.fulfill({ json: url.includes("description") ? c.club : { payment_mode: "at_desk" } });
    if (url.includes("/rest/v1/courts")) return route.fulfill({ json: courts });
    if (url.includes("/rest/v1/price_rules")) return route.fulfill({ json: rules });
    if (url.includes("/rest/v1/club_media")) return route.fulfill({ json: c.gallery });
    return route.fulfill({ status: 200, json: {} });
  });
  if (c.zoom) {
    await page.addInitScript((z) => {
      const scale = () => document.querySelectorAll("div").forEach((el) => {
        if (el.dataset.scaled) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (el.childElementCount === 0 && el.textContent && fs) { el.style.fontSize = `${fs * z}px`; el.style.lineHeight = "normal"; el.dataset.scaled = "1"; }
      });
      new MutationObserver(scale).observe(document, { subtree: true, childList: true });
    }, c.zoom);
  }
  await page.goto(`http://localhost:8099/club/club-1?name=Batroun&tab=info`);
  await page.getByText("Prices per hour").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  const text = await page.evaluate(() => document.body.innerText);
  // Section titles are drawn in capitals (text-transform), so compare without case.
  const missing = (c.expect ?? []).filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
  const extra = (c.absent ?? []).filter((t) => new RegExp(`(^|\\n)${t}(\\n|$)`, "i").test(text));
  // Nothing may stick out past the right edge of the screen.
  const overflow = await page.evaluate((w) => [...document.querySelectorAll("div")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > w + 1 && getComputedStyle(el).overflowX !== "scroll" && !el.closest('[aria-label="Photos"]');
  }).length, c.w);
  const tag = c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page.screenshot({ path: `${SHOTS}/info-${tag}.png`, fullPage: false });
  // the whole tab, by scrolling the inner list and stitching is overkill: take screens down the page
  for (let i = 1; i <= 3; i++) {
    await page.mouse.move(c.w / 2, c.h / 2);
    await page.mouse.wheel(0, c.h - 160);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/info-${tag}-${i}.png` });
  }
  const ok = !missing.length && !extra.length && overflow === 0;
  console.log(`${c.name}: ${ok ? "OK" : "FAIL"}${missing.length ? ` missing ${missing}` : ""}${extra.length ? ` should be absent ${extra}` : ""}${overflow ? ` ${overflow} element(s) past the edge` : ""}`);
  if (!ok) failures++;
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
