// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/** The fee "Pay" button keeps its request key until the tap's outcome is known (review of PR #34, blocker 2). */
const replace = vi.fn(), refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: vi.fn() }) }));
const { default: PayPanel } = await import("./PayPanel");

const props = {
  bookingId: "b1", paymentId: "0c000000-0000-4000-8000-000000000001", status: "pending", clubName: "Club", clubSlug: "club",
  timezone: "Asia/Beirut", courtName: "Court 1", startAt: "2026-12-01T08:00:00Z", endAt: "2026-12-01T09:00:00Z",
  holdExpiresAt: new Date(Date.now() + 600_000).toISOString(), price: 25, fee: 1, total: 1, feeOnly: true, simulated: false,
  lastAttempt: null, attemptsLeft: 3,
};
let answers: Array<{ status: number; body: unknown } | "network">;
let sentKeys: string[];
beforeEach(() => {
  sentKeys = []; replace.mockReset(); refresh.mockReset();
  let n = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => `0c000000-0000-4000-8000-00000000000${++n}` as `${string}-${string}-${string}-${string}-${string}`);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sentKeys.push(JSON.parse(String(init.body)).requestKey);
    const a = answers.shift()!;
    if (a === "network") throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const tap = async () => {
  const before = sentKeys.length;
  fireEvent.click(screen.getByRole("button", { name: /Pay the \$1\.00 booking fee/ }));
  await waitFor(() => expect(sentKeys.length).toBe(before + 1));
  await waitFor(() => expect((screen.getByRole("button", { name: /Pay the \$1\.00 booking fee/ }) as HTMLButtonElement).disabled).toBe(false));
};

describe("PayPanel fee button: one request key per tap, kept until the outcome is known", () => {
  it("in progress, uncertain, a lost answer or an unreadable one: the next tap sends the SAME key", async () => {
    answers = [
      { status: 409, body: { error: "payment_in_progress", final: false } },
      { status: 502, body: { error: "payment_uncertain", final: false } },
      "network",
      { status: 500, body: "<html>" },
      { status: 200, body: { attempt: "a", state: "failed" } },
    ];
    render(<PayPanel {...props} />);
    for (let i = 0; i < 5; i++) await tap();
    expect(new Set(sentKeys).size).toBe(1);
  });
  it("a finished attempt or a final refusal: the next tap is a new attempt with a new key", async () => {
    answers = [
      { status: 200, body: { attempt: "a", state: "expired" } },
      { status: 502, body: { error: "gateway_error", final: true } },
      { status: 409, body: { error: "payment_in_progress", final: false } },
    ];
    render(<PayPanel {...props} />);
    for (let i = 0; i < 3; i++) await tap();
    expect(sentKeys[0]).not.toBe(sentKeys[1]);
    expect(sentKeys[1]).not.toBe(sentKeys[2]);
  });
  it("a confirmed outcome goes to the booking", async () => {
    answers = [{ status: 200, body: { attempt: "a", outcome: "confirmed" } }];
    render(<PayPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Pay the \$1\.00 booking fee/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/bookings/b1?new=1"));
  });
});
