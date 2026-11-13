jest.mock("expo-crypto", () => ({ randomUUID: () => "tok-1" }));
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn() } }));
import { supabase } from "../lib/supabase";
import { newAttempt, reserve } from "../lib/reserve";

const rpc = supabase.rpc as jest.Mock;
const attempt = (mode: string) =>
  newAttempt({ mode, clubId: "club", courtId: "court", start: new Date("2026-11-14T16:30:00Z"), end: new Date("2026-11-14T18:00:00Z") });
const now = { waitMs: () => 0 };

beforeEach(() => rpc.mockReset());

describe("reserve", () => {
  it("sends one token on every retry, and returns the booking the first call made", async () => {
    rpc
      .mockRejectedValueOnce(new TypeError("Network request failed")) // response lost after the server committed
      .mockResolvedValueOnce({ data: [{ booking_id: "b1", payment_id: "p1", hold_expires_at: "t", already: true }], error: null });
    const r = await reserve(attempt("simulated"), now);
    expect(r).toEqual({ kind: "reserved", value: { bookingId: "b1", paymentId: "p1", holdExpiresAt: "t", already: true, confirmed: false } });
    expect(rpc).toHaveBeenCalledTimes(2);
    const tokens = rpc.mock.calls.map((c) => c[1].p_token);
    expect(tokens).toEqual(["tok-1", "tok-1"]);
    expect(rpc.mock.calls[0][0]).toBe("hold_slot");
  });

  it("uses book_at_desk with the same token for clubs that take payment at the desk", async () => {
    rpc.mockResolvedValueOnce({ data: [{ booking_id: "b2", already: false }], error: null });
    const r = await reserve(attempt("at_desk"), now);
    expect(rpc.mock.calls[0][0]).toBe("book_at_desk");
    expect(rpc.mock.calls[0][1].p_token).toBe("tok-1");
    expect(r).toMatchObject({ kind: "reserved", value: { bookingId: "b2", confirmed: true, already: false } });
  });

  it("does not retry a refusal; it is final", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "slot_taken", code: "P0001" } });
    const r = await reserve(attempt("simulated"), now);
    expect(r).toMatchObject({ kind: "refused", failure: { kind: "refused", reason: "slot_taken" } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("says 'uncertain', never 'failed', when the network never comes back", async () => {
    rpc.mockRejectedValue(new TypeError("Network request failed"));
    const r = await reserve(attempt("simulated"), now);
    expect(r).toMatchObject({ kind: "uncertain", failure: { kind: "network" } });
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});
