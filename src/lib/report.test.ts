import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: { message: string; tags: Record<string, string> }[] = [];
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, ctx: { tags: Record<string, string> }) => { captured.push({ message, tags: ctx.tags }); },
  captureException: vi.fn(),
  flush: async () => true,
}));
const settled = () => reportsSettled();
const { explainBookingError, reportAuthError, reportsSettled, safeCode, FALLBACK_TEXTS } = await import("./report");

beforeEach(async () => { await reportsSettled(); captured.length = 0; });

describe("explainBookingError", () => {
  it("shows the same text as before W2a", async () => {
    const { friendlyError } = await import("./types");
    for (const m of ["slot_taken", "too_late_to_cancel", "boom", undefined]) expect(explainBookingError(m)).toBe(friendlyError(m));
  });
  it("reports only what friendlyError does not recognise, with the code and no text", async () => {
    explainBookingError("slot_taken", "P0001");
    expect(captured).toEqual([]);
    explainBookingError("relation \"bookings\" does not exist: Jana", "42P01");
    explainBookingError(undefined);
    await reportsSettled();
    expect(captured).toHaveLength(2);   // sent once the SDK has loaded, in either order
    expect(captured).toEqual(expect.arrayContaining([
      { message: "booking: unexpected error", tags: { area: "booking", code: "42P01" } },
      { message: "booking: unexpected error", tags: { area: "booking" } },
    ]));
  });
  it("uses the caller's own wording when given (blocks), reporting only its fallback", async () => {
    expect(explainBookingError("not_on_grid", "P0001", "A block must start and end on the grid.")).toBe("A block must start and end on the grid.");
    await settled();
    expect(captured).toEqual([]);
  });
  it("knows both fallback texts", () => {
    expect([...FALLBACK_TEXTS]).toEqual(["Something went wrong.", "Something went wrong. Refresh and try again."]);
  });
});

describe("safeCode", () => {
  it("passes codes, replaces anything that is not a code", () => {
    expect(safeCode("23P01")).toBe("23P01");
    expect(safeCode("PGRST116")).toBe("PGRST116");
    expect(safeCode(503)).toBe("503");
    expect(safeCode("probe@example.invalid")).toBe("other");
    expect(safeCode("two words")).toBe("other");
    expect(safeCode(undefined)).toBeUndefined();
  });
});

describe("reportAuthError", () => {
  it("reports service failures, not the person's own mistakes or an offline phone", async () => {
    await reportAuthError("authCodeCheck", { status: 403, code: "otp_expired" });
    await reportAuthError("authCodeSend", { status: 429, code: "over_email_send_rate_limit" });
    await reportAuthError("authCodeSend", { status: 0 });            // browser offline
    await reportAuthError("authCodeSend", null);
    expect(captured).toEqual([]);
    await reportAuthError("authCodeSend", { status: 500, code: "unexpected_failure" });
    await reportAuthError("authCodeExchange", { code: "fetch_failed" }, true);   // server could not reach auth
    expect(captured).toEqual([
      { message: "auth: sign-in code could not be sent", tags: { area: "auth", code: "unexpected_failure", status: "500" } },
      { message: "auth: code exchange failed", tags: { area: "auth", code: "fetch_failed" } },
    ]);
  });
});
