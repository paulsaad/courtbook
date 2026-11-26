// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: a booking cancelled on another device stayed on Bookings as "Your next booking"
 * when the player came back to the app after 35 s, and after Back; a game left elsewhere stayed listed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
import FreshOnReturn, { STALE_AFTER_MS } from "./FreshOnReturn";

let visibility = "visible";
let online = true;
const setVisibility = (v: string) => { visibility = v; document.dispatchEvent(new Event("visibilitychange")); };
beforeEach(() => {
  vi.useFakeTimers(); refresh.mockReset(); visibility = "visible"; online = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("fresh data when a player comes back", () => {
  it("back after 30 s or more: the page's data is read again", () => {
    render(<FreshOnReturn />);
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 5000); setVisibility("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a quick switch away does not", () => {
    render(<FreshOnReturn />);
    setVisibility("hidden"); vi.advanceTimersByTime(5000); setVisibility("visible");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("Back/Forward reads the page again, after Next.js has shown it", () => {
    render(<FreshOnReturn />);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(refresh).not.toHaveBeenCalled();
    act(() => { vi.runAllTimers(); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("a page restored from the browser's back-forward cache is read again", () => {
    render(<FreshOnReturn />);
    const e = new Event("pageshow") as PageTransitionEvent; Object.defineProperty(e, "persisted", { value: true });
    window.dispatchEvent(e);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offline: nothing (a refresh would replace the page with the browser's offline page)", () => {
    render(<FreshOnReturn />);
    online = false;
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 1); setVisibility("visible");
    window.dispatchEvent(new PopStateEvent("popstate")); act(() => { vi.runAllTimers(); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops listening when removed", () => {
    const { unmount } = render(<FreshOnReturn />);
    unmount();
    setVisibility("hidden"); vi.advanceTimersByTime(STALE_AFTER_MS + 1); setVisibility("visible");
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
