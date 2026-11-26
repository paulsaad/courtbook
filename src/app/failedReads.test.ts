// W1 (audit B2): a failed read must never look like "nothing here". For every page, each read the page makes is
// failed in turn: the page must stop with LoadError (shown by error.tsx as "Couldn't load this page"). With every
// read succeeding — including empty answers — the page must never raise LoadError.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoadError } from "@/lib/load";

/** One row that satisfies the fields pages read from a `.single()` answer. */
const ROW = {
  id: "id-1", slug: "batroun", name: "Club", timezone: "Asia/Beirut", open_time: "08:00:00", close_time: "23:00:00",
  slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, booking_window_days: 14,
  service_fee_usd: 0, payment_mode: "at_desk", town_id: null, location_url: null, is_demo: false, active: true,
  roles: ["player", "admin"], status: "confirmed", club_id: "club-1", start_at: "2099-01-01T10:00:00Z",
  end_at: "2099-01-01T11:00:00Z", hold_expires_at: null, price_usd: 20, fee_usd: 0, total_usd: 20, provider: "simulated",
  clubs: { name: "Club", slug: "batroun", timezone: "Asia/Beirut", cancel_cutoff_hours: 6, location_url: null, payment_mode: "at_desk" },
  courts: { name: "Padel 1", sport: "padel" }, sports: [], levels: [], whatsapp: null, bio: null,
};
/** Calls that write rather than read: never failed here (pages do not depend on them). */
const WRITES = new Set(["mark_notifications_read"]);

const state = vi.hoisted(() => ({ reads: [] as string[], failAt: -1, failWith: "outage" as "outage" | "manyRows", noRows: false }));
/** The exact PGRST116 answers PostgREST gives on staging for a single-row read (W1 review). */
const MANY_ROWS = { code: "PGRST116", details: "The result contains 2 rows", message: "Cannot coerce the result to a single JSON object" };
const NO_ROWS = { code: "PGRST116", details: "The result contains 0 rows", message: "Cannot coerce the result to a single JSON object" };
function answer(name: string, single: boolean) {
  const n = state.reads.length;
  state.reads.push(name);
  if (n === state.failAt) return { data: null, error: state.failWith === "manyRows" ? MANY_ROWS : { message: "connection lost", code: "08006" }, count: null };
  if (single && state.noRows) return { data: null, error: NO_ROWS, count: null };
  return { data: single ? ROW : [], error: null, count: 0 };
}
function query(name: string, isWrite = false) {
  let single = false;
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "or", "not", "order", "limit", "gt", "lt", "gte", "lte", "range", "filter", "match", "ilike", "contains"]) b[m] = () => b;
  b.single = () => { single = true; return b; };
  b.maybeSingle = () => { single = true; return b; };
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(isWrite ? { data: null, error: null } : answer(name, single)).then(res, rej);
  return b;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => query(`from:${table}`),
    rpc: (fn: string) => query(`rpc:${fn}`, WRITES.has(fn)),
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "player@example.test" } }, error: null }) },
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }), headers: async () => new Headers() }));

type Page = (props: { params: Promise<Record<string, string>>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
/** The fourth entry names reads a page already reports inside the page itself (an in-page "couldn't load" state with
 *  the risky actions disabled); failing one of those must NOT replace the page, and every other read must. */
const PAGES: [string, () => Promise<{ default: unknown }>, Record<string, string>, string[]?][] = [
  ["home", () => import("./page"), {}],
  ["my bookings", () => import("./me/page"), {}],
  ["a booking", () => import("./bookings/[id]/page"), { id: "id-1" }],
  ["a payment", () => import("./pay/[id]/page"), { id: "id-1" }],
  ["games board", () => import("./play/page"), {}],
  ["coaches", () => import("./coaches/page"), {}],
  ["a coach", () => import("./coaches/[id]/page"), { id: "id-1" }],
  ["club info", () => import("./club/[slug]/info/page"), { slug: "batroun" }],
  ["club coaches", () => import("./club/[slug]/coaches/page"), { slug: "batroun" }],
  ["club games", () => import("./club/[slug]/matches/page"), { slug: "batroun" }],
  ["a game", () => import("./matches/[id]/page"), { id: "id-1" }],
  ["activity", () => import("./notifications/page"), {}],
  ["profile", () => import("./profile/page"), {}, ["rpc:my_photo_version"]],   // optional: the profile loads without photos
  ["levels", () => import("./levels/page"), {}],
  ["coach page", () => import("./coach/page"), {}],
  ["staff index", () => import("./staff/page"), {}],
  ["staff payments", () => import("./staff/[slug]/payments/page"), { slug: "batroun" }],
  ["staff settings", () => import("./staff/[slug]/settings/page"), { slug: "batroun" }],
  ["admin", () => import("./admin/page"), {}],
  ["admin payments", () => import("./admin/payments/page"), {}],
  ["admin club", () => import("./admin/clubs/[slug]/page"), { slug: "batroun" }],
  ["admin reports", () => import("./admin/reports/page"), {}, ["rpc:admin_reports"]],
  ["club booking page", () => import("./club/[slug]/page"), { slug: "batroun" }, ["from:occupancy"]],
  ["courts", () => import("./courts/page"), {}, ["rpc:club_day_slots"]],
  ["staff calendar", () => import("./staff/[slug]/page"), { slug: "batroun" }, ["from:bookings", "from:blocks"]],
];

/** Runs the page; returns what it threw (or null). Next's redirect/notFound are thrown errors too. */
async function run(load: () => Promise<{ default: unknown }>, params: Record<string, string>) {
  const Page = (await load()).default as Page;
  try { await Page({ params: Promise.resolve(params), searchParams: Promise.resolve({}) }); return null; }
  catch (e) { return e; }
}

beforeEach(() => { state.reads = []; state.failAt = -1; state.failWith = "outage"; state.noRows = false; });

describe("failed reads never look like empty data (W1, audit B2)", () => {
  for (const [label, load, params, inPage = []] of PAGES) {
    it(`${label}: every read checked; successful (even empty) reads never raise LoadError`, async () => {
      state.failAt = -1;
      const ok = await run(load, params);
      expect(ok instanceof LoadError, `${label} raised LoadError with every read succeeding`).toBe(false);
      if (ok && !(String((ok as { digest?: string }).digest ?? "").startsWith("NEXT_"))) throw ok;   // only redirect/notFound allowed
      const reads = [...state.reads];
      expect(reads.length, `${label} made no reads`).toBeGreaterThan(0);
      for (const name of inPage) expect(reads, `${label}: ${name} is not read any more`).toContain(name);
      for (let k = 0; k < reads.length; k++) {
        state.reads = []; state.failAt = k;
        const err = await run(load, params);
        if (inPage.includes(reads[k])) {
          expect(err instanceof LoadError, `${label}: ${reads[k]} is reported inside the page, not by replacing it`).toBe(false);
          if (err && !(String((err as { digest?: string }).digest ?? "").startsWith("NEXT_"))) throw err;
        } else {
          expect(err instanceof LoadError, `${label}: failing read #${k + 1} (${reads[k]}) did not stop the page`).toBe(true);
        }
      }
    });

    it(`${label}: several rows from a single-row read is a failed load, never "not found"`, async () => {
      const reads = (state.failAt = -1, await run(load, params), [...state.reads]);
      for (let k = 0; k < reads.length; k++) {
        if (inPage.includes(reads[k])) continue;
        state.reads = []; state.failAt = k; state.failWith = "manyRows";
        expect(await run(load, params) instanceof LoadError, `${label}: several rows at read #${k + 1} (${reads[k]}) did not stop the page`).toBe(true);
      }
    });

    it(`${label}: a stated zero-row answer is "not found" or empty, never a failed load`, async () => {
      state.noRows = true;
      const err = await run(load, params);
      expect(err instanceof LoadError, `${label} treated zero rows as a failed load`).toBe(false);
      if (err && !(String((err as { digest?: string }).digest ?? "").startsWith("NEXT_"))) throw err;
    });
  }
});
