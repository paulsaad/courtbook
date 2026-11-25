import { describe, expect, it } from "vitest";
import { paymentsByBooking } from "./staffPayments";
import { settlement } from "./types";

const reader = (answer: { data: unknown; error: unknown } | "throw") => ({
  from: () => ({ select: () => ({ in: async () => { if (answer === "throw") throw new Error("network"); return answer; } }) }),
});
const rows = [{ id: "a", source: "app" as const, status: "confirmed" as const }, { id: "b", source: "app" as const, status: "confirmed" as const }];

describe("staff payment read (review 24 Nov)", () => {
  it("each booking gets its own payment, or null when it has none", async () => {
    const out = await paymentsByBooking(reader({ data: [{ booking_id: "a", status: "paid" }], error: null }), rows);
    expect(out.map((r) => r.payments)).toEqual([{ status: "paid" }, null]);
    expect(out.map((r) => settlement(r))).toEqual(["paid_in_app", "at_desk"]);
  });
  it("a refused read leaves every payment unknown: none is shown as paid", async () => {
    const out = await paymentsByBooking(reader({ data: null, error: { message: "permission denied" } }), rows);
    expect(out.map((r) => r.payments)).toEqual([undefined, undefined]);
    expect(out.map((r) => settlement(r))).toEqual(["unknown", "unknown"]);
  });
  it("a network failure too", async () => {
    const out = await paymentsByBooking(reader("throw"), rows);
    expect(out.map((r) => settlement(r))).toEqual(["unknown", "unknown"]);
  });
  it("no bookings: no read", async () => {
    expect(await paymentsByBooking(reader("throw"), [])).toEqual([]);
  });
});

describe("settlement(): every state", () => {
  const s = (extra: object) => settlement({ source: "app", status: "confirmed", ...extra } as never);
  it("walk-ins are always settled at the desk", () => expect(settlement({ source: "staff", status: "confirmed", payments: undefined })).toBe("at_desk"));
  it.each([["paid", "paid_in_app"], ["pending", "awaiting"], ["refund_due", "refund_owed"], ["refunded", "refund_owed"], ["failed", "not_paid"], ["expired", "not_paid"]])("payment %s → %s", (st, want) => {
    expect(s({ payments: { status: st } })).toBe(want);
    expect(s({ payments: [{ status: st }] })).toBe(want);
  });
  it("no payment row → at the desk; not read → unknown; a pending hold without a row → unknown", () => {
    expect(s({ payments: null })).toBe("at_desk");
    expect(s({ payments: undefined })).toBe("unknown");
    expect(s({ payments: undefined, fee_usd: 1 })).toBe("unknown");          // never inferred from the fee
    expect(s({ status: "pending", payments: null })).toBe("unknown");
  });
});

describe("settlement() for a fee-only payment (M12.1): the court is always taken at the desk", () => {
  const s = (st: string) => settlement({ source: "app", status: "confirmed", payments: { status: st, kind: "fee_only" } } as never);
  it.each([["paid", "fee_paid"], ["pending", "fee_awaiting"], ["refund_due", "fee_refund"], ["refunded", "fee_refund"], ["expired", "not_paid"]])("fee %s → %s", (st, want) => expect(s(st)).toBe(want));
  it("never says 'paid in the app' for a fee-only payment; a live one tells the desk the court is due", async () => {
    const { SETTLEMENT_TEXT } = await import("./types");
    for (const st of ["paid", "pending", "refund_due", "refunded"]) expect(s(st)).not.toBe("paid_in_app");
    for (const st of ["paid", "pending"]) expect(SETTLEMENT_TEXT[s(st)]).toMatch(/court due at the desk/);
    expect(SETTLEMENT_TEXT[s("refund_due")]).toMatch(/CourtBook is refunding .* nothing for the desk/);
  });
  it("the read keeps the kind", async () => {
    const reader = { from: () => ({ select: () => ({ in: async () => ({ data: [{ booking_id: "a", status: "paid", kind: "fee_only" }], error: null }) }) }) };
    const out = await paymentsByBooking(reader, [{ id: "a", source: "app" as const, status: "confirmed" as const }]);
    expect(settlement(out[0])).toBe("fee_paid");
  });
});
