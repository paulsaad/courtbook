import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/** After the first-time profile, the profile form sends the person to ?next= (router.replace). Never another site. */
vi.mock("next/navigation", () => ({ redirect: (u: string) => { throw new Error(`redirect ${u}`); } }));
const q = (data: unknown, count = 0) => {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) b[m] = () => b;
  b.single = async () => ({ data, error: null });
  b.then = (r: (v: unknown) => unknown) => r({ data: Array.isArray(data) ? data : [], count, error: null });
  return b;
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1", email: "a@b.example", phone: null } } }) },
    from: (t: string) => (t === "profiles" ? q({ name: null, roles: ["player"] }) : q([])),
    rpc: async () => ({ data: [], error: null }),
  }),
}));
const { default: ProfilePage } = await import("./page");

async function nextProp(next: string | undefined): Promise<string> {
  const el = (await ProfilePage({ searchParams: Promise.resolve({ next }) })) as ReactElement<{ next: string }>;
  return el.props.next;
}

describe("profile: where the form sends the person afterwards", () => {
  it("the page they came from, on this site", async () => {
    expect(await nextProp("/club/batroun?at=x")).toBe("/club/batroun?at=x");
    expect(await nextProp(undefined)).toBe("/");
  });
  for (const attack of ["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example"]) {
    it(`never another site: next=${JSON.stringify(attack)} → "/"`, async () => {
      expect(await nextProp(attack)).toBe("/");
    });
  }
});
