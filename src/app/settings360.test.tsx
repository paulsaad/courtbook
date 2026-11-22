// @vitest-environment node
/**
 * Club settings at 360 px, staff and admin pages (W1, staging finding 22 Nov): no sideways scrolling and every
 * control at least 44 px tall on a phone.
 *
 * jsdom has no layout, so this renders the real pages with realistic data (database mocked), applies the site's real
 * stylesheet (compiled here by Tailwind, as the build does), and measures the result in headless Chrome emulating a
 * phone (as the staging check did). It needs a Chrome binary (CHROME, or /usr/bin/google-chrome); without one it is skipped, and says so.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToReadableStream } from "react-dom/server";

const CHROME = process.env.CHROME ?? ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
const ROOT = join(__dirname, "..", "..");

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon";

// --- realistic data: two courts, a price rule, a staff member, a coach request, a cover and a gallery photo ---
const CLUB = {
  id: "c1", name: "Batroun Padel & Tennis Club", slug: "batroun", active: true, timezone: "Asia/Beirut",
  location_url: "https://maps.google.com/?q=Batroun", open_time: "08:00", close_time: "23:00", slot_minutes: 30,
  min_booking_minutes: 60, max_booking_minutes: 120, cancel_cutoff_hours: 6, hold_minutes: 10, booking_window_days: 14,
  service_fee_usd: 1, town_id: "t1", lat: 34.2553, lng: 35.6586, payment_mode: "at_desk", max_upcoming_bookings: 3,
  description: "Five courts by the sea.", address: "Main road, Batroun", arrival: "Gate behind the bakery", is_demo: true,
};
const DATA: Record<string, unknown> = {
  clubs: CLUB,
  profiles: { roles: ["admin"] },
  courts: [
    { id: "k1", name: "Padel 1", sport: "padel", surface: "artificial grass", active: true, sort: 1 },
    { id: "k2", name: "Tennis Centre Court", sport: "tennis", surface: "hard", active: false, sort: 2 },
  ],
  price_rules: [{ id: "r1", court_id: null, weekday_mask: 127, start_time: "08:00", end_time: "17:00", price_usd: 20, label: "Daytime" }],
  club_media: [
    { id: "m1", kind: "cover", path: "clubs/c1/cover.webp", external_url: null, caption: null, sort: 0, width: 1600, height: 600 },
    { id: "m2", kind: "gallery", path: "clubs/c1/g1.webp", external_url: null, caption: "Padel 1 at sunset", sort: 1, width: 1200, height: 900 },
  ],
  sports: [
    { code: "padel", name_en: "Padel", name_ar: "بادل", sort_order: 1, active: true },
    { code: "tennis", name_en: "Tennis", name_ar: "تنس", sort_order: 2, active: true },
  ],
  towns: { id: "t1", district_code: "batroun", name_en: "Batroun", name_ar: "البترون", districts: { governorate_code: "north" } },
  "rpc:areas": [{ code: "north", name_en: "North", name_ar: "الشمال", districts: [{ code: "batroun", name_en: "Batroun", name_ar: "البترون" }] }],
  "rpc:club_staff_list": [{ profile_id: "p2", name: "Rami Haddad", email: "rami.haddad@example.com" }],
  "rpc:club_coach_requests": [{ coach_id: "co1", name: "Nadia Khoury", sports: ["padel", "tennis"], price_usd: 35, status: "pending" }],
};

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error(`redirect ${u}`); },
  notFound: () => { throw new Error("notFound"); },
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, back() {}, prefetch() {} }),
  usePathname: () => "/staff/batroun/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const answer = (key: string, single: boolean) => {
      const v = DATA[key];
      if (key === "club_staff") return { data: null, error: null, count: 1 };
      return { data: single ? (Array.isArray(v) ? v[0] : v) : (Array.isArray(v) ? v : v ? [v] : []), error: null, count: null };
    };
    const builder = (key: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "in", "limit"]) b[m] = () => b;
      b.single = async () => answer(key, true);
      b.maybeSingle = async () => answer(key, true);
      b.then = (ok: (r: unknown) => unknown) => Promise.resolve(answer(key, false)).then(ok);
      return b;
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
      from: (t: string) => builder(t),
      rpc: (fn: string) => builder(`rpc:${fn}`),
    };
  },
}));

let css: string | null = null;
async function stylesheet() {
  if (css) return css;
  const { compile } = await import("@tailwindcss/node");
  const { Scanner } = await import("@tailwindcss/oxide");
  const base = join(ROOT, "src", "app");
  const compiler = await compile(readFileSync(join(base, "globals.css"), "utf8"), { base, onDependency: () => {} });
  css = compiler.build(new Scanner({ sources: [{ base: join(ROOT, "src"), pattern: "**/*", negated: false }] }).scan());
  return css;
}

/** Runs in the page: sideways overflow and every visible control shorter than 44 px. */
const MEASURE = `
  const W = document.documentElement.clientWidth;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const controls = [...document.querySelectorAll("main a, main button, main input, main select, main textarea, main [role=button]")]
    .filter(vis).filter((e) => !["checkbox", "radio", "file", "hidden"].includes(e.type));
  const small = controls.filter((e) => e.getBoundingClientRect().height < 43.5)
    .map((e) => e.tagName.toLowerCase() + ' "' + (e.textContent || e.getAttribute("aria-label") || e.placeholder || "").trim().slice(0, 30) + '" ' + Math.round(e.getBoundingClientRect().height) + "px");
  const wide = [...document.body.querySelectorAll("*")].filter((e) => vis(e) && e.getBoundingClientRect().right > W + 1)
    .map((e) => e.tagName.toLowerCase() + ' "' + (e.textContent || "").trim().slice(0, 24) + '"').slice(0, 5);
  const out = document.createElement("pre"); out.id = "measure";
  out.textContent = JSON.stringify({ width: W, sideways: document.documentElement.scrollWidth - W, controls: controls.length, small, wide });
  document.body.appendChild(out);`;

/** Minimal Chrome DevTools session: emulates the phone (headless windows cannot be narrower than 500 px). */
async function chromeMeasure(file: string, width: number) {
  const { spawn } = await import("node:child_process");
  const profile = mkdtempSync(join(tmpdir(), "settings360-profile-"));
  const proc = spawn(CHROME!, ["--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const wsBrowser = await new Promise<string>((ok, fail) => {
      let buf = "";
      const t = setTimeout(() => fail(new Error("Chrome did not start")), 30_000);
      proc.stderr!.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); ok(m[1]); } });
    });
    const port = new URL(wsBrowser).port;
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
    let id = 0;
    const pending = new Map<number, (v: unknown) => void>();
    const events: ((m: { method: string }) => void)[] = [];
    ws.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); } else events.forEach((f) => f(m)); });
    const send = (method: string, params: object = {}) => new Promise<unknown>((ok) => { const n = ++id; pending.set(n, ok); ws.send(JSON.stringify({ id: n, method, params })); });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: width < 640 ? 2 : 1, mobile: width < 640 });
    const loaded = new Promise<void>((ok) => events.push((m) => { if (m.method === "Page.loadEventFired") ok(); }));
    await send("Page.navigate", { url: `file://${file}` });
    await loaded;
    const r = (await send("Runtime.evaluate", { expression: `document.getElementById("measure").textContent`, returnByValue: true })) as { result: { value: string } };
    ws.close();
    return JSON.parse(r.result.value) as { width: number; sideways: number; controls: number; small: string[]; wide: string[] };
  } finally { proc.kill(); }
}

async function measure(page: () => Promise<unknown>, width: number) {
  const stream = await renderToReadableStream((await page()) as React.ReactElement, { onError: (e) => { throw e; } });
  await stream.allReady;                                       // wait for every async part (no loading states left)
  const html = await new Response(stream).text();
  const dir = mkdtempSync(join(tmpdir(), "settings360-"));
  const file = join(dir, "page.html");
  writeFileSync(file, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${await stylesheet()}</style></head><body>${html}<script>${MEASURE}</script></body></html>`);
  return chromeMeasure(file, width);
}

const PAGES: [string, () => Promise<unknown>][] = [
  ["staff settings", async () => (await import("./staff/[slug]/settings/page")).default({ params: Promise.resolve({ slug: "batroun" }) })],
  ["admin club settings", async () => (await import("./admin/clubs/[slug]/page")).default({ params: Promise.resolve({ slug: "batroun" }) })],
];

describe.skipIf(!CHROME)("club settings at 360 px (W1)", () => {
  for (const [label, page] of PAGES) {
    it(`${label}: no sideways scrolling and every control at least 44 px tall`, async () => {
      const r = await measure(page, 360);
      expect(r.width, "the page was not laid out at 360 px").toBe(360);
      expect(r.controls, "nothing was rendered").toBeGreaterThan(40);
      expect(r.sideways, `scrolls sideways; too wide: ${r.wide.join(", ")}`).toBe(0);
      expect(r.small, "controls under 44 px on a phone").toEqual([]);
    }, 120_000);

    it(`${label}: desktop width still lays out without sideways scrolling`, async () => {
      const r = await measure(page, 1280);
      expect(r.sideways).toBe(0);
    }, 120_000);
  }
});

if (!CHROME) console.warn("settings360.test.tsx skipped: no Chrome binary (set CHROME to run the 360 px layout check)");
