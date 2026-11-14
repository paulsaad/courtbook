// Renders the club availability screen at phone sizes with faked Supabase answers and checks that
// no time is under the booking panel, including the last time of the day after selecting it.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.WEBOUT ?? "/tmp/courtbook-webout";
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  let f = path.join(ROOT, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "index.html");
  const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".html") ? "text/html" : f.endsWith(".ttf") ? "font/ttf" : "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  fs.createReadStream(f).pipe(res);
}).listen(8099);

// Tomorrow in Beirut (UTC+2 in November)
const now = new Date();
const d = new Date(now.getTime() + 2 * 3600e3 + 24 * 3600e3);
const date = d.toISOString().slice(0, 10);
const courts = ["Padel 1", "Padel 2", "Padel 3", "Pitch 1", "Tennis 1", "Tennis 2"];
const rows = [];
for (let h = 8 * 60; h <= 22 * 60; h += 30) {
  const start = new Date(`${date}T00:00:00Z`).getTime() + (h - 120) * 60e3;
  courts.forEach((c, i) =>
    rows.push({
      club_id: "club-1", club_name: "Batroun Padel & Tennis Club", slug: "batroun", town: "Batroun", district: "Batroun",
      price_from: 20, sports: ["padel", "tennis", "football"], slot_minutes: 30, min_minutes: 60, max_minutes: 180,
      service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut",
      court_id: `court-${i}`, court_name: c, court_sport: c.startsWith("Padel") ? "padel" : c.startsWith("Tennis") ? "tennis" : "football",
      start_at: new Date(start).toISOString().replace("Z", "+00:00"), free_minutes: Math.min(180, 23 * 60 - h), is_demo: true,
    }));
}

const sizes = [
  { name: "iPhone SE (375x667)", w: 375, h: 667 },
  { name: "iPhone 15 (393x852)", w: 393, h: 852 },
  { name: "iPhone 15 Pro Max (430x932)", w: 430, h: 932 },
  { name: "iPhone SE, text 140%", w: 375, h: 667, zoom: 1.4 },
];

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let failures = 0;
for (const s of sizes) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.route("https://fakeproj.supabase.co/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/rpc/club_day_slots")) return route.fulfill({ json: rows });
    if (url.includes("/rpc/quote_price")) {
      const body = route.request().postDataJSON();
      const hour = new Date(body.p_start).getUTCHours() + 2;
      const mins = (Date.parse(body.p_end) - Date.parse(body.p_start)) / 60e3;
      const rate = (hour >= 17 ? 30 : 20) + (body.p_court === "court-1" ? 4 : 0);
      return route.fulfill({ json: rate * mins / 60 });
    }
    if (url.includes("/rest/v1/clubs")) return route.fulfill({ json: { payment_mode: "at_desk" } });
    return route.fulfill({ status: 200, json: {} });
  });
  if (s.zoom) {
    // Approximates a larger text setting: every font size scaled; layout must wrap, not clip.
    await page.addInitScript((z) => {
      const scale = () => document.querySelectorAll("div[dir], div").forEach((el) => {
        if (el.dataset.scaled) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (el.childElementCount === 0 && el.textContent && fs) { el.style.fontSize = `${fs * z}px`; el.style.lineHeight = "normal"; el.dataset.scaled = "1"; }
      });
      new MutationObserver(scale).observe(document, { subtree: true, childList: true });
    }, s.zoom);
  }
  await page.goto(`http://localhost:8099/club/club-1?name=Batroun&date=${date}`);
  await page.getByLabel(/^21:00/).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500); // prices

  // 1. Select a time near the bottom of the first screenful.
  const tiles = page.getByRole("button", { name: /^\d\d:\d\d, / });
  const count = await tiles.count();
  let pick = null;
  for (let i = 0; i < count; i++) {
    const b = await tiles.nth(i).boundingBox();
    if (b && b.y + b.height > s.h - 80 && b.y < s.h) { pick = tiles.nth(i); break; }
  }
  pick ??= tiles.nth(Math.min(8, count - 1));
  const pickedLabel = (await pick.getAttribute("aria-label")).slice(0, 5);
  await pick.click();
  await page.waitForTimeout(900);
  const panel = await page.getByTestId("booking-panel").boundingBox();
  const sel = await page.getByRole("button", { name: new RegExp(`^${pickedLabel}, .*selected`) }).boundingBox();
  const okSel = sel && sel.y >= 0 && sel.y + sel.height <= panel.y + 0.5;
  await page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/${s.w}x${s.h}${s.zoom ? "-text" : ""}-selected.png` });

  // 2. Scroll to the very end: the last time must sit fully above the panel.
  await page.mouse.move(s.w / 2, panel.y / 2);
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 600);
  await page.waitForTimeout(800);
  const last = await tiles.nth(count - 1).boundingBox();
  const panel2 = await page.getByTestId("booking-panel").boundingBox();
  const okLast = last && last.y + last.height <= panel2.y + 0.5;
  const reserve = await page.getByRole("button", { name: /Reserve|Sign in to reserve/ }).boundingBox();
  const okButton = reserve && reserve.y + reserve.height <= s.h + 0.5;
  await page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/${s.w}x${s.h}${s.zoom ? "-text" : ""}-end.png` });

  const line = `${s.name}: picked ${pickedLabel} → bottom ${Math.round(sel?.y + sel?.height)} vs panel top ${Math.round(panel.y)} ${okSel ? "OK" : "COVERED"}; ` +
    `last time bottom ${Math.round(last.y + last.height)} vs panel top ${Math.round(panel2.y)} ${okLast ? "OK" : "COVERED"}; ` +
    `panel height ${Math.round(panel2.height)}, button ${okButton ? "visible" : "OFF SCREEN"}`;
  console.log(line);
  if (!okSel || !okLast || !okButton) failures++;
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
