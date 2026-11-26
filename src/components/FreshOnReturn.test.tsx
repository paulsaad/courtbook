// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: a booking cancelled on another device stayed on Bookings as "Your next booking"
 * when the player came back to the app after 35 s, and after Back; a game left elsewhere stayed listed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import FreshOnReturn, { PROBE_TIMEOUT_MS, STALE_AFTER_MS, serverReachable } from "./FreshOnReturn";

let visibility = "visible";
let online = true;
let health: () => Promise<{ ok: boolean }> = async () => ({ ok: true });
const fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
  void url;
  return new Promise<{ ok: boolean }>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    health().then(resolve, reject);
  });
});
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const setVisibility = (v: string) => { visibility = v; document.dispatchEvent(new Event("visibilitychange")); };
beforeEach(() => {
  vi.useFakeTimers(); refresh.mockReset(); fetchMock.mockClear(); visibility = "visible"; online = true;
  health = async () => ({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("fresh data when a player comes back", () => {
  it("back after 30 s or more: the page's data is read again (after checking CourtBook answers)", async () => {
    render(<FreshOnReturn />);
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 5000); setVisibility("visible");
    await settle();
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.objectContaining({ cache: "no-store" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a quick switch away does not", async () => {
    render(<FreshOnReturn />);
    setVisibility("hidden"); vi.advanceTimersByTime(5000); setVisibility("visible");
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Back/Forward reads the page again, after Next.js has shown it", async () => {
    render(<FreshOnReturn />);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(fetchMock).not.toHaveBeenCalled();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a page restored from the browser's back-forward cache is read again", async () => {
    render(<FreshOnReturn />);
    const e = new Event("pageshow") as PageTransitionEvent; Object.defineProperty(e, "persisted", { value: true });
    window.dispatchEvent(e);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offline: nothing, not even the check", async () => {
    render(<FreshOnReturn />);
    online = false;
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 1); setVisibility("visible");
    window.dispatchEvent(new PopStateEvent("popstate")); await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  // Verified on the local pilot build: phone online, server unreachable → the refresh fell back to a full page
  // load, the browser's error page replaced the page and the half-filled "Post a match" form was lost.
  it.each([
    ["the site answers 503 (database down)", () => async () => ({ ok: false })],
    ["the site cannot be reached (online but no route)", () => async () => { throw new TypeError("Failed to fetch"); }],
  ])("online but %s: no refresh, the page stays", async (_, make) => {
    health = make();
    render(<FreshOnReturn />);
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 1); setVisibility("visible");
    await settle();
    window.dispatchEvent(new PopStateEvent("popstate")); await settle();
    expect(fetchMock).toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a check that hangs is given up after the timeout: no refresh", async () => {
    health = () => new Promise(() => {});
    render(<FreshOnReturn />);
    window.dispatchEvent(new PopStateEvent("popstate")); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10); });
    expect(refresh).not.toHaveBeenCalled();
    const pending = serverReachable(fetchMock as unknown as typeof fetch);
    await act(async () => { await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 10); });
    await expect(pending).resolves.toBe(false);
  });

  it("stops listening when removed", async () => {
    const { unmount } = render(<FreshOnReturn />);
    unmount();
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 1); setVisibility("visible");
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("mounted on every page", () => {
  it("the root layout renders it", async () => {
    vi.doMock("@/components/TabBar", () => ({ default: () => null }));
    const { default: RootLayout } = await import("@/app/layout");
    const found: unknown[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const el = n as { type?: unknown; props?: { children?: unknown } };
      if (el.type === FreshOnReturn) found.push(el);
      walk(el.props?.children);
    };
    walk(RootLayout({ children: null }));
    expect(found).toHaveLength(1);
  });
});
