// @vitest-environment jsdom
/**
 * W5 (Paul, 26 Nov): cancelling with no connection said "Something went wrong. Refresh and try again." It now says
 * the connection failed, with Reserve's offline sentence; the booking is left as it is, nothing is reloaded, and
 * "Yes, cancel" tries again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const router = { replace: vi.fn(), refresh: vi.fn() };
let answers: { data: unknown; error: unknown }[] = [];
const calls: [string, Record<string, unknown>][] = [];
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return answers.shift() ?? { data: null, error: null }; } }),
}));
import CancelButton from "./CancelButton";

const base = { bookingId: "b1", cutoffHours: 6, cutoffLabel: "Fri 28 Nov 12:00", clubInfoHref: "/club/test/info", freeCancel: true, nothingPaid: true };
beforeEach(() => { answers = []; calls.length = 0; router.replace.mockReset(); router.refresh.mockReset(); });
afterEach(cleanup);

async function confirmCancel() {
  render(<CancelButton {...base} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel booking" }));
  fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));
}

describe("cancel with no connection (W5)", () => {
  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])("%s: says the connection failed; nothing reloaded", async (message) => {
    answers = [{ data: null, error: { message } }];
    await confirmCancel();
    await waitFor(() => expect(screen.getByText("Couldn't reach CourtBook. Check your connection and try again.")).toBeTruthy());
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(calls).toEqual([["cancel_booking", { p_booking: "b1", p_club_caused: false }]]);   // one call, nothing else sent
  });

  it("back online, the same button cancels", async () => {
    answers = [{ data: null, error: { message: "Failed to fetch" } }, { data: null, error: null }];
    await confirmCancel();
    const yes = await screen.findByRole("button", { name: "Yes, cancel" });
    await waitFor(() => expect((yes as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(yes);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/bookings"));
    expect(calls).toHaveLength(2);
  });

  it("a server refusal keeps its own message (the cancel arrived earlier: no longer active)", async () => {
    answers = [{ data: null, error: { message: "not_confirmed" } }];
    await confirmCancel();
    await waitFor(() => expect(screen.getByText("This booking is no longer active.")).toBeTruthy());
    expect(screen.queryByText(/Couldn't reach CourtBook/)).toBeNull();
  });
});
