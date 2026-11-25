import { beforeEach, describe, expect, it, vi } from "vitest";

/** The website's reservation call (review of PR #34): every path sends the attempt's token, so a retry after a lost
 *  answer returns the same booking instead of taking a second one. The database side is tested through the API
 *  (supabase/tests/api/journey.mjs, BF13–BF15). */
const rpc = vi.fn();
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
const { reserve } = await import("./reserve");

const base = { clubId: "club", courtId: "court", start: new Date("2026-12-01T08:00:00Z"), end: new Date("2026-12-01T09:00:00Z"), token: "tok-1" };
beforeEach(() => rpc.mockReset());

describe("reserve (website)", () => {
  it.each(["simulated", "fee_online", null])("hold_slot gets the token (mode %s)", async (mode) => {
    rpc.mockResolvedValue({ data: [{ booking_id: "b1", payment_id: "p1" }], error: null });
    await reserve({ ...base, mode });
    expect(rpc).toHaveBeenCalledWith("hold_slot", expect.objectContaining({ p_token: "tok-1" }));
  });
  it("book_at_desk gets the token", async () => {
    rpc.mockResolvedValue({ data: [{ booking_id: "b1" }], error: null });
    await reserve({ ...base, mode: "at_desk" });
    expect(rpc).toHaveBeenCalledWith("book_at_desk", expect.objectContaining({ p_token: "tok-1" }));
  });
  it("the same token on a retry", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } }).mockResolvedValueOnce({ data: [{ booking_id: "b1", payment_id: "p1" }], error: null });
    expect((await reserve({ ...base, mode: "fee_online" })).ok).toBe(false);
    expect(await reserve({ ...base, mode: "fee_online" })).toEqual({ ok: true, value: { bookingId: "b1", href: "/pay/b1" } });
    expect(rpc.mock.calls.map((c) => c[1].p_token)).toEqual(["tok-1", "tok-1"]);
  });
  it("a hold with no payment ($0 fee, confirmed) goes to the booking, not to payment", async () => {
    rpc.mockResolvedValue({ data: [{ booking_id: "b2", payment_id: null }], error: null });
    expect(await reserve({ ...base, mode: "fee_online" })).toEqual({ ok: true, value: { bookingId: "b2", href: "/bookings/b2?new=1" } });
  });
});
