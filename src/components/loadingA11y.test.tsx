// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov:
 * - while a page loaded (loading.tsx), a screen reader found an empty page, and the grey blocks kept
 *   pulsing with "reduce motion" on;
 * - with large text (Android font size 150–200 %), the Coaches list cut the coach's name ("Ziad Co…")
 *   and the club and town at 320–390 px.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: async () => ({ data: [{ coach_id: "c1", name: "Ziad Abdelrahman Haddad-Bustros", sports: ["padel", "tennis"], levels: [], price_usd: 30, whatsapp: null, club_id: "k1", club_name: "Batroun Padel & Tennis Club and Beach Sports Centre", club_slug: "batroun", town: "Batroun" }], error: null }),
    from: () => ({ select: async () => ({ data: [{ code: "padel", name_en: "Padel" }, { code: "tennis", name_en: "Tennis" }], error: null }) }),
  }),
}));

import RootLoading from "@/app/loading";
import MeLoading from "@/app/me/loading";
import PlayLoading from "@/app/play/loading";
import ClubLoading from "@/app/club/[slug]/loading";
import CoachesPage from "@/app/coaches/page";

afterEach(cleanup);

describe("loading screens", () => {
  it.each([["root", RootLoading], ["bookings", MeLoading], ["find a game", PlayLoading], ["club", ClubLoading]])("%s: says Loading to screen readers; the blocks are hidden and still with reduced motion", (_, Loading) => {
    const { container } = render(<Loading />);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
    const blocks = [...container.querySelectorAll(".bg-slate-soft")];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(b.closest("[aria-hidden=true]")).not.toBeNull();
      expect(b.className.split(" ")).toContain("motion-safe:animate-pulse");
      expect(b.className.split(" ")).not.toContain("animate-pulse");
    }
  });
});

describe("Coaches list at large text", () => {
  it("the coach's name and the club line wrap instead of being cut", async () => {
    render(await CoachesPage());
    const name = screen.getByText("Ziad Abdelrahman Haddad-Bustros");
    const line = screen.getByText(/Batroun Padel & Tennis Club and Beach Sports Centre/);
    for (const el of [name, line]) {
      expect(el.className.split(" ")).not.toContain("truncate");
      expect(el.className.split(" ")).toContain("break-words");
    }
  });
});
