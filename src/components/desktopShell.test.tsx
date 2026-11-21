// @vitest-environment jsdom
/**
 * Phase I-1: desktop shell. Phones keep the bottom tab bar exactly as before (now marked lg:hidden);
 * desktop gets a top bar; sheets close with Esc and, on desktop, keep focus inside.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));
const nav = vi.hoisted(() => ({ path: "/", user: null as null | { id: string }, unread: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: nav.user } }) },
    from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ count: nav.unread }) }) }) }),
  }),
}));

import TabBar from "./TabBar";
import WorkNav from "./WorkNav";
import { useDialog } from "./useDialog";

afterEach(cleanup);
const desktop = (on: boolean) => {
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("1024"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};

describe("player navigation", () => {
  beforeEach(() => { nav.user = { id: "u1" }; nav.unread = 0; nav.path = "/"; });

  it("signed in: the phone tab bar is unchanged except that it hides from 1024 px; the top bar shows from 1024 px", async () => {
    const { container } = render(<TabBar />);
    await waitFor(() => expect(container.querySelector("nav.fixed.bottom-0")).toBeTruthy());
    const bottom = container.querySelector("nav.fixed.bottom-0")!;
    expect(bottom.className).toContain("lg:hidden");
    expect([...bottom.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Home", "Courts", "Bookings", "Profile"]);
    const top = container.querySelector("header")!;
    expect(top.className).toMatch(/(^| )hidden( |$)/);
    expect(top.className).toContain("lg:block");
    const labels = [...top.querySelectorAll("nav a")].map((a) => a.getAttribute("aria-label") ?? a.textContent);
    expect(labels).toEqual(["CourtBook home", "Home", "Courts", "Find a game", "Bookings", "Profile", "Notifications"]);
  });

  it("the unread count shows on the desktop bell and on the phone Profile tab", async () => {
    nav.unread = 3;
    const { container } = render(<TabBar />);
    await waitFor(() => expect(screen.getByLabelText("Notifications, 3 unread")).toBeTruthy());
    expect(container.querySelector('nav.fixed.bottom-0 a[href="/notifications"]')).toBeTruthy();
  });

  it("signed out: no phone tab bar (as before); the desktop bar offers only visitor pages and Sign in", async () => {
    nav.user = null;
    const { container } = render(<TabBar />);
    await waitFor(() => expect(container.querySelector("header")).toBeTruthy());
    expect(container.querySelector("nav.fixed.bottom-0")).toBeNull();
    const hrefs = [...container.querySelectorAll("header a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#main", "/", "/", "/courts", "/play", "/login"]);
  });

  it.each([
    ["/staff/batroun", false, false], ["/admin/reports", false, false], ["/login", false, false], ["/pay/x", false, false],
    ["/coach", false, true], ["/play", true, true], ["/matches/1", true, true], ["/club/batroun", true, true],
  ])("%s: phone tab bar %s, desktop top bar %s", async (path, phone, top) => {
    nav.path = path;
    const { container } = render(<TabBar />);
    await waitFor(() => expect(nav.user).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(!!container.querySelector("nav.fixed.bottom-0")).toBe(phone);
    expect(!!container.querySelector("header")).toBe(top);
  });

  it("marks the current page for screen readers", async () => {
    nav.path = "/matches/abc";
    render(<TabBar />);
    await waitFor(() => expect(screen.getByText("Find a game").getAttribute("aria-current")).toBe("page"));
  });
});

describe("staff and admin desktop bar", () => {
  it("staff: calendar, payments, settings of that club, and a way back to the player side", () => {
    const { container } = render(<WorkNav area="staff" slug="batroun" clubName="Batroun Padel & Tennis Club" active="payments" />);
    expect(container.querySelector("header")!.className).toContain("lg:block");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/staff/batroun", "/staff/batroun/payments", "/staff/batroun/settings", "/me", "/profile"]);
    expect(screen.getByText("Payments").getAttribute("aria-current")).toBe("page");
  });
  it("admin: clubs, payments, reports, the staff calendar, and the player side", () => {
    const { container } = render(<WorkNav area="admin" active="reports" />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/admin", "/admin/payments", "/admin/reports", "/staff", "/me", "/profile"]);
  });
});

function Sheet({ busy = false, modal = true }: { busy?: boolean; modal?: boolean }) {
  const [open, setOpen] = useState(true);
  const ref = useDialog<HTMLDivElement>(open, () => setOpen(false), { canClose: !busy, modal });
  return (
    <>
      <button>outside</button>
      {open && <div ref={ref} data-testid="panel"><button>first</button><button>last</button></div>}
    </>
  );
}

describe("sheets: Esc and focus", () => {
  it("Esc closes", () => {
    desktop(false);
    render(<Sheet />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
  });
  it("Esc does nothing while saving", () => {
    desktop(true);
    render(<Sheet busy />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("panel")).toBeTruthy();
  });
  it("phone: focus is not moved", () => {
    desktop(false);
    screen.queryByText("outside");
    render(<Sheet />);
    expect(document.activeElement).toBe(document.body);
  });
  it("desktop: focus moves into the panel and Tab wraps inside it", () => {
    desktop(true);
    render(<Sheet />);
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
    screen.getByText("last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });
  it("desktop, non-modal panel (club booking card): focus stays where it was", () => {
    desktop(true);
    render(<Sheet modal={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("page containers: phones keep max-w-md; tablet and desktop widen", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) files.push(p); } };
  walk("src");
  it("every <main> that is max-w-md on phones also has a tablet width (md:) and a desktop width (lg:)", () => {
    const narrow = files.flatMap((p) => [...readFileSync(p, "utf8").matchAll(/<main className="([^"]*)"/g)].map((m) => ({ p, c: m[1] })))
      .filter(({ c }) => /(^| )max-w-md( |$)/.test(c));
    expect(narrow.length).toBeGreaterThan(15);
    for (const { p, c } of narrow) {
      expect(c, p).toMatch(/ md:max-w-2xl/);
      expect(c, p).toMatch(/ lg:max-w-(\[720px\]|3xl)/);
    }
  });
});
