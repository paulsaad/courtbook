// @vitest-environment jsdom
/**
 * Local pilot build, 26 Nov: a signed-in player who reached /login?next=/me saw "Sign in to CourtBook" again.
 * They now go straight on to the safe `next`; signed-out visitors get the form as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let user: { id: string } | null = null;
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) } }) }));
vi.mock("./LoginForm", () => ({ default: () => null }));
import LoginPage from "./page";

const page = (next?: string | string[]) => LoginPage({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });
beforeEach(() => { user = null; });

describe("/login", () => {
  it("signed out: the sign-in form", async () => {
    await expect(page("/me")).resolves.toBeTruthy();
  });
  it("signed in: straight on to next", async () => {
    user = { id: "u1" };
    await expect(page("/me")).rejects.toThrow("redirect:/me");
    await expect(page("/club/batroun?at=2026-11-28T16:00:00.000Z&court=k1&dur=90")).rejects.toThrow("redirect:/club/batroun?at=2026-11-28T16:00:00.000Z&court=k1&dur=90");
  });
  it("signed in: an unsafe or missing next goes Home, never off-site", async () => {
    user = { id: "u1" };
    for (const n of [undefined, "https://evil.example/x", "//evil.example", "/\\evil"]) await expect(page(n)).rejects.toThrow(/^redirect:\/$/);
    await expect(page(["/me", "/x"])).rejects.toThrow("redirect:/me");
  });
});
