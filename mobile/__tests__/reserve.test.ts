jest.mock("expo-crypto", () => ({ randomUUID: () => "tok-1" }));
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
import { supabase } from "../lib/supabase";
import { CALL_TIMEOUT_MS, findByToken, newAttempt, reserve } from "../lib/reserve";

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

describe("reserve — answers that are not a refusal", () => {
  it("retries a gateway error with the same token; it may have committed", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: { message: "Bad Gateway", code: "" } })
      .mockResolvedValueOnce({ data: [{ booking_id: "b3", already: true }], error: null });
    const r = await reserve(attempt("at_desk"), now);
    expect(r).toMatchObject({ kind: "reserved", value: { bookingId: "b3", already: true } });
    expect(rpc.mock.calls.map((c) => c[1].p_token)).toEqual(["tok-1", "tok-1"]);
  });

  it("gives up waiting after the time limit and treats it as no answer, not a failure", async () => {
    jest.useFakeTimers();
    try {
      // a request that hangs until it is aborted, as supabase-js reports an abort
      rpc.mockImplementation(() => {
        let signal: AbortSignal | undefined;
        const p = new Promise((resolve) => {
          const wait = () => (signal ? signal.addEventListener("abort", () => resolve({ data: null, error: { message: "AbortError: Aborted", code: "" } })) : setTimeout(wait, 0));
          wait();
        });
        return Object.assign(p, { abortSignal: (s: AbortSignal) => { signal = s; return p; } });
      });
      const pending = reserve(attempt("at_desk"), { attempts: 1, waitMs: () => 0 });
      await jest.advanceTimersByTimeAsync(CALL_TIMEOUT_MS + 10);
      expect(await pending).toMatchObject({ kind: "uncertain", failure: { kind: "network" } });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("findByToken", () => {
  const from = supabase.from as jest.Mock;
  const chain = (result: unknown) => {
    const c: { select: () => unknown; eq: jest.Mock; maybeSingle: () => Promise<unknown> } = { select: () => c, eq: jest.fn(() => c), maybeSingle: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) };
    from.mockReturnValueOnce(c);
    return c;
  };
  it("finds the booking the token made", async () => {
    const c = chain({ data: { id: "b9", status: "confirmed" }, error: null });
    expect(await findByToken("tok-1")).toEqual({ kind: "found", bookingId: "b9", status: "confirmed" });
    expect(c.eq).toHaveBeenCalledWith("client_token", "tok-1");
  });
  it("'absent' only when the database answered", async () => {
    chain({ data: null, error: null });
    expect(await findByToken("t")).toEqual({ kind: "absent" });
    chain({ data: null, error: { message: "TypeError: Network request failed", code: "" } });
    expect(await findByToken("t")).toEqual({ kind: "unreachable" });
    chain(new TypeError("Network request failed"));
    expect(await findByToken("t")).toEqual({ kind: "unreachable" });
  });
});
