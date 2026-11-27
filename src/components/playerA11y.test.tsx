// @vitest-environment jsdom
/**
 * Website accessibility defects found with axe-core on the local pilot build at 360 px (26 Nov):
 * - phone tab bar: inactive labels #8a918e on white (3.2:1, below WCAG AA 4.5:1) and no aria-current;
 * - "Post a match": the date and time fields had no label (axe "label", critical);
 * - coach page: white text on WhatsApp green #25D366 (2.0:1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));
const nav = vi.hoisted(() => ({ path: "/courts", unread: 0 }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ is: async () => ({ count: nav.unread }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import TabBar from "./TabBar";
import MatchBoard from "./MatchBoard";

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const hexIn = (cls: string, prefix: string) => cls.match(new RegExp(`${prefix}-\\[(#[0-9a-fA-F]{6})\\]`))?.[1];

afterEach(cleanup);

describe("phone tab bar", () => {
  beforeEach(() => { nav.path = "/courts"; nav.unread = 0; });

  it("marks the current tab for screen readers", async () => {
    const { container } = render(<TabBar />);
    await waitFor(() => expect(container.querySelector("nav.fixed.bottom-0")).toBeTruthy());
    const links = [...container.querySelectorAll("nav.fixed.bottom-0 a")];
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null, null]);
    expect(container.querySelector("nav.fixed.bottom-0")!.getAttribute("aria-label")).toBe("Main");
  });

  it("inactive labels meet WCAG AA contrast on white", async () => {
    const { container } = render(<TabBar />);
    await waitFor(() => expect(container.querySelector("nav.fixed.bottom-0")).toBeTruthy());
    const inactive = container.querySelector('nav.fixed.bottom-0 a[href="/"]')!.className;
    const color = hexIn(inactive, "text");
    expect(color).toBeTruthy();
    expect(contrast(color!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("the Profile tab says how many notifications are unread", async () => {
    nav.unread = 2;
    render(<TabBar />);
    expect(await screen.findByLabelText("Profile, 2 unread notifications")).toBeTruthy();
  });
});

describe("Post a match form", () => {
  it("date and time fields have names", () => {
    const club = { id: "c1", name: "Club", slug: "c", timezone: "Asia/Beirut", open_time: "08:00", close_time: "23:00", slot_minutes: 30 };
    render(<MatchBoard club={club} rows={[]} myBookings={[]} sports={[{ code: "padel", name_en: "Padel" }]} />);
    fireEvent.click(screen.getByText("Post a match"));
    expect((screen.getByLabelText("Date") as HTMLInputElement).type).toBe("date");
    expect((screen.getByLabelText("Start time") as HTMLInputElement).type).toBe("time");
  });
});

describe("WhatsApp button on the coach page", () => {
  it("its text meets WCAG AA contrast on WhatsApp green", () => {
    const src = readFileSync(join(process.cwd(), "src/app/coaches/[id]/page.tsx"), "utf8");
    const cls = src.match(/className="([^"]*bg-\[#25D366\][^"]*)"/)![1];
    const text = cls.includes("text-white") ? "#ffffff" : cls.includes("text-ink") ? "#121614" : null;
    expect(text).not.toBeNull();
    expect(contrast(text!, "#25D366")).toBeGreaterThanOrEqual(4.5);
  });
});
