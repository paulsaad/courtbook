// @vitest-environment jsdom
/**
 * H18 (Session B's round 5, Paul 26 Nov): the Profile badge read the unread count only when the path changed, so
 * notices read or received on another device left it stale after a return. It now re-reads on return to the page
 * and after a game page marked its notices read (H11), with no polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/matches/A" }));
const db = vi.hoisted(() => ({ unread: 4, reads: 0, fail: false }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "rana" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ is: async () => { db.reads++; return db.fail ? { count: null, error: { message: "Failed to fetch" } } : { count: db.unread }; } }) }) }),
  }),
}));
import TabBar from "./TabBar";
import NoticesRead from "@/app/matches/[id]/NoticesRead";
import { NOTICES_READ_EVENT } from "@/lib/noticeRead";

const badge = () => screen.queryByRole("link", { name: /unread notification/ })?.getAttribute("aria-label") ?? "none";
const setVisibility = (v: "visible" | "hidden") => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v }); document.dispatchEvent(new Event("visibilitychange")); };
beforeEach(() => { db.unread = 4; db.reads = 0; db.fail = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("unread badge (H18)", () => {
  it("returning to the page re-reads the count (notices read on another device)", async () => {
    render(<TabBar />);
    await waitFor(() => expect(badge()).toBe("Profile, 4 unread notifications"));
    setVisibility("hidden");
    db.unread = 0;
    await act(async () => { setVisibility("visible"); });
    await waitFor(() => expect(badge()).toBe("none"));
  });
  it("a game page that marked its notices read updates the badge without a path change (H11 with a #91 refresh)", async () => {
    render(<TabBar />);
    await waitFor(() => expect(badge()).toBe("Profile, 4 unread notifications"));
    db.unread = 1;   // game A's 3 were marked; game B's 1 stays
    await act(async () => { window.dispatchEvent(new Event(NOTICES_READ_EVENT)); });
    await waitFor(() => expect(badge()).toBe("Profile, 1 unread notification"));
  });
  it("no polling: nothing is read while the page just stays open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });
    render(<TabBar />);
    await vi.waitFor(() => expect(db.reads).toBe(1));
    await act(async () => { vi.advanceTimersByTime(10 * 60_000); });
    expect(db.reads).toBe(1);
  });
  it("a count that can't be read on return keeps the badge (it used to drop to 0)", async () => {
    render(<TabBar />);
    await waitFor(() => expect(badge()).toBe("Profile, 4 unread notifications"));
    db.fail = true;
    await act(async () => { setVisibility("visible"); });
    await waitFor(() => expect(db.reads).toBe(2));
    expect(badge()).toBe("Profile, 4 unread notifications");
  });
});

describe("NoticesRead (the game page's signal)", () => {
  it("signals only when the page marked something, and again when a refresh marks new ones", () => {
    const seen = vi.fn(); window.addEventListener(NOTICES_READ_EVENT, seen);
    const { rerender } = render(<NoticesRead marked="" />);
    expect(seen).toHaveBeenCalledTimes(0);
    rerender(<NoticesRead marked="a1,a2" />);
    expect(seen).toHaveBeenCalledTimes(1);
    rerender(<NoticesRead marked="a1,a2" />);
    expect(seen).toHaveBeenCalledTimes(1);
    rerender(<NoticesRead marked="a3" />);
    expect(seen).toHaveBeenCalledTimes(2);
    window.removeEventListener(NOTICES_READ_EVENT, seen);
  });
});
