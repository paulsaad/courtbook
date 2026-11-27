// @vitest-environment jsdom
/** Reserve on the Courts sheet: missing name/phone → the details step with this selection; nothing booked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let me: { data: unknown; error: unknown } = { data: { name: null, phone: null }, error: null };
let rpcs: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async (fn: string) => { rpcs.push(fn); return fn === "book_at_desk" ? { data: [{ booking_id: "b1" }], error: null } : { data: 20, error: null }; },
    from: (t: string) => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq"]) b[m] = () => b;
      b.single = async () => ({ data: { payment_mode: "at_desk" }, error: null }); b.maybeSingle = async () => (t === "profiles" ? me : { data: null, error: null }); return b; },
  }),
}));
import BookSheet from "./BookSheet";

const club = { id: "c1", name: "Test Club", slug: "test", slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 0, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut" };
beforeEach(() => { rpcs = []; nav.push.mockReset(); });
afterEach(cleanup);
async function reserve() {
  render(<BookSheet club={club} date="2026-12-01" at="2026-12-01T08:00:00Z" courts={[{ id: "k1", name: "Court 1", free: 120 }]} initialCourtId="k1" initialMinutes={60} signedIn onClose={() => {}} />);
  const b = await screen.findByRole("button", { name: /Reserve — you pay at the club/ });
  await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(b);
}

describe("Courts sheet Reserve: details before a first booking", () => {
  it("nothing given yet: the details step, back to /courts with this selection; nothing booked", async () => {
    me = { data: { name: null, phone: null }, error: null };
    await reserve();
    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const to = decodeURIComponent(String(nav.push.mock.calls[0][0]));
    expect(to.startsWith("/details?next=/courts?")).toBe(true);
    expect(to).toContain("court=k1"); expect(to).toContain("dur=60"); expect(to).toContain("date=2026-12-01");
    expect(rpcs).not.toContain("book_at_desk");
  });
  it("complete profile: books", async () => {
    me = { data: { name: "Rana", phone: "+96170123456" }, error: null };
    await reserve();
    await waitFor(() => expect(rpcs).toContain("book_at_desk"));
  });
});
