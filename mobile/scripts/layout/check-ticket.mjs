// Renders the real booking confirmation screen (signed in with a fake session, faked Supabase
// answers) at phone sizes and text scales, and checks the time range never touches the court mark.
import { chromium } from "playwright-core";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.env.WEBOUT ?? "/tmp/courtbook-webout";
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(ROOT, "index.html");
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : f.endsWith(".ttf") ? "font/ttf" : "text/html" });
  fs.createReadStream(f).pipe(res);
}).listen(8099);

const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "t@courtbook.test", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
const session = { access_token: "x.y.z", refresh_token: "r", token_type: "bearer", expires_in: 360000, expires_at: Math.floor(Date.now() / 1000) + 360000, user };
const tomorrow = new Date(Date.now() + 26 * 3600e3).toISOString().slice(0, 10);
const booking = (start, end) => ({
  id: "b1", status: "confirmed", start_at: `${tomorrow}T${start}:00+00:00`, end_at: `${tomorrow}T${end}:00+00:00`, price_usd: 45, fee_usd: 0, cancelled_at: null,
  clubs: { name: "Batroun Padel & Tennis Club", slug: "batroun", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: "https://maps.google.com/?q=Batroun", payment_mode: "at_desk" },
  courts: { name: "Tennis 1", sport: "tennis" },
});

const cases = [
  { name: "iPhone SE", w: 375, h: 667, scale: 1 },
  { name: "iPhone 15", w: 393, h: 852, scale: 1 },
  { name: "iPhone 15 Pro Max", w: 430, h: 932, scale: 1 },
  { name: "iPhone SE, text ×1.3", w: 375, h: 667, scale: 1.3 },
  { name: "iPhone SE, text ×1.6 (app maximum)", w: 375, h: 667, scale: 1.6 },
  { name: "iPhone 15, text ×1.6", w: 393, h: 852, scale: 1.6 },
];
const times = [["19:30", "21:00"], ["08:00", "11:00"]]; // UTC → 21:30–23:00 and 10:00–13:00 in Beirut

const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"] });
let failures = 0;
for (const c of cases) for (const [s, e] of times) {
  const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
  await ctx.addInitScript((sess) => localStorage.setItem("sb-fakeproj-auth-token", JSON.stringify(sess)), session);
  if (c.scale !== 1) {
    // Larger text: scale every text run's font size, as the phone's text-size setting does (capped in-app at ×1.6).
    await ctx.addInitScript((z) => {
      const scale = () => document.querySelectorAll("div").forEach((el) => {
        if (el.dataset.scaled || el.childElementCount !== 0 || !el.textContent) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs) { el.style.fontSize = `${fs * z}px`; el.style.lineHeight = "normal"; el.dataset.scaled = "1"; }
      });
      new MutationObserver(scale).observe(document, { subtree: true, childList: true });
    }, c.scale);
  }
  const page = await ctx.newPage();
  await page.route("https://fakeproj.supabase.co/**", (route) => {
    const url = route.request().url();
    if (url.includes("/rest/v1/bookings")) {
      const b = booking(s, e);
      return route.fulfill({ json: (route.request().headers()["accept"] ?? "").includes("vnd.pgrst.object") ? b : [b] });
    }
    if (url.includes("/auth/v1/user")) return route.fulfill({ json: user });
    return route.fulfill({ json: [] });
  });
  await page.goto("http://localhost:8099/booking/b1?new=1");
  await page.getByTestId("ticket-end").waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const start = await page.getByTestId("ticket-start").boundingBox();
  const end = await page.getByTestId("ticket-end").boundingBox();
  const mark = await page.getByTestId("ticket-mark").boundingBox();
  const perf = await page.getByTestId("ticket-perforation").boundingBox();
  const endText = await page.getByTestId("ticket-end").innerText();
  // Clear of the marking, of each other, of the screen edge, and wholly above the perforation.
  const ok = !overlap(end, mark) && !overlap(start, mark) && !overlap(start, end) && end.x + end.width <= c.w &&
    end.y + end.height <= perf.y + 0.5 && end.x + end.width <= mark.x - 8;
  const wrapped = end.y >= start.y + start.height - 2;
  const file = `${process.env.SHOTS ?? "/tmp"}/ticket-${c.w}-${c.scale}-${s.replace(":", "")}.png`;
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: c.w, height: Math.min(c.h, mark.y + mark.height + 120) } });
  console.log(`${c.name}, ${endText}: ${ok ? "OK" : "OVERLAP"}${wrapped ? " (end time on its own line)" : " (end time beside the start)"}; end bottom ${Math.round(end.y + end.height)} vs perforation ${Math.round(perf.y)}, end right ${Math.round(end.x + end.width)} vs marking ${Math.round(mark.x)}`);
  if (!ok) failures++;
  await ctx.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
