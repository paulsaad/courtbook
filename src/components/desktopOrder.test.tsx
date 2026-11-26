// @vitest-environment jsdom
/**
 * H7 (Session B's round-3 handover): at 1280 px the top bar came after the page content in the DOM, so the first Tab
 * landed in the content and "Skip to content" came last (WCAG 2.4.3). The layout now has a #top-nav slot before
 * #main and the desktop bar is placed there; the phone bar stays after the content.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ count: 0 }) }) }) }),
  }),
}));
import TabBar from "./TabBar";
afterEach(cleanup);

// the layout's body, as in src/app/layout.tsx: slot, content, then the bars
function Shell() {
  return (<><div id="top-nav" /><div id="main" tabIndex={-1}><main><a href="/x">First link in the page</a></main></div><TabBar /></>);
}
const focusable = () => [...document.body.querySelectorAll<HTMLElement>("a[href], button")];

describe("desktop keyboard order (H7)", () => {
  it("the layout puts the #top-nav slot before #main", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout.indexOf('id="top-nav"')).toBeGreaterThan(-1);
    expect(layout.indexOf('id="top-nav"')).toBeLessThan(layout.indexOf('id="main"'));
  });
  it("Skip to content and the top navigation come before the page content; the phone bar after it", async () => {
    render(<Shell />);
    await waitFor(() => expect(document.querySelector("#top-nav header")).toBeTruthy());
    const order = focusable().map((e) => e.textContent?.trim());
    const skip = order.indexOf("Skip to content"), page = order.indexOf("First link in the page");
    expect(skip).toBe(0);
    expect(page).toBeGreaterThan(skip);
    const phone = document.querySelector("nav.fixed.bottom-0")!;
    expect(document.getElementById("main")!.compareDocumentPosition(phone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
