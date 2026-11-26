// @vitest-environment jsdom
/** The Courts page's booking sheet says a demo (simulated) club charges no real money; a desk club never shows it. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

let MODE = "simulated";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: 20, error: null }),
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq"]) b[m] = () => b; b.single = async () => ({ data: { payment_mode: MODE }, error: null }); return b; },
  }),
}));
import BookSheet from "./BookSheet";

const club = { id: "c1", name: "Test Club", slug: "test", slot_minutes: 30, min_minutes: 60, max_minutes: 120, service_fee_usd: 1, hold_minutes: 10, cancel_cutoff_hours: 6, timezone: "Asia/Beirut" };
async function sheet(mode: string) {
  MODE = mode;
  render(<BookSheet club={club} date="2026-12-01" at="2026-12-01T08:00:00Z" courts={[{ id: "k1", name: "Court 1", free: 120 }]} initialCourtId="k1" initialMinutes={60} signedIn onClose={() => {}} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /Reserve/ }).textContent).not.toBe("Reserve and pay"));
  await waitFor(() => expect(document.body.textContent).toContain("$20.00"));
  return document.body.textContent ?? "";
}
afterEach(cleanup);

describe("Courts page booking sheet: demo wording", () => {
  it("simulated: the demo note before the hold line; the payment flow is unchanged", async () => {
    const t = await sheet("simulated");
    expect(t).toContain("Demo club: no real money is charged · Slot held 10 minutes while you pay");
    expect(t).toContain("Reserve and pay $21.00");
  });
  it("at the desk: no demo note", async () => {
    const t = await sheet("at_desk");
    expect(t).not.toContain("Demo club");
    expect(t).toContain("Reserve — you pay at the club");
  });
});
