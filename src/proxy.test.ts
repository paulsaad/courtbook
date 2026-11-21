import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

/** What the mocked Supabase client does when the proxy asks for the claims: renew (write cookies) or not. */
const auth = vi.hoisted(() => ({ renew: null as null | { cookies: { name: string; value: string; options: object }[]; headers: Record<string, string> }, calls: 0, seen: [] as string[] }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { getAll: () => { name: string; value: string }[]; setAll: (c: { name: string; value: string; options: object }[], h: Record<string, string>) => void } }) => ({
    auth: {
      getClaims: async () => {
        auth.calls++;
        auth.seen = opts.cookies.getAll().map((c) => `${c.name}=${c.value}`);
        if (auth.renew) opts.cookies.setAll(auth.renew.cookies, auth.renew.headers);
        return { data: null, error: null };
      },
    },
  }),
}));

import { config, proxy } from "./proxy";

const SESSION = "sb-pwznauyioqykdwodwpvx-auth-token";
const req = (cookie?: string) => new NextRequest("https://example.test/me", { headers: cookie ? { cookie } : {} });

beforeEach(() => { auth.renew = null; auth.calls = 0; auth.seen = []; });

describe("session proxy (W1, audit B1)", () => {
  it("an expired session is renewed: the new cookie goes to the browser and to the page being rendered, never cached", async () => {
    auth.renew = {
      cookies: [{ name: SESSION, value: "renewed", options: { path: "/", sameSite: "lax", httpOnly: false, maxAge: 34560000 } }],
      headers: { "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0", Expires: "0", Pragma: "no-cache" },
    };
    const request = req(`${SESSION}=old`);
    const res = await proxy(request);
    expect(auth.seen).toEqual([`${SESSION}=old`]);                    // the session in the request was read
    expect(res.cookies.get(SESSION)?.value).toBe("renewed");             // browser gets the renewed session
    expect(request.cookies.get(SESSION)?.value).toBe("renewed");         // so does the page rendered after it
    expect(res.headers.get("x-middleware-override-headers")).toContain("cookie");
    expect(res.headers.get("x-middleware-request-cookie")).toContain(`${SESSION}=renewed`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache, no-store, must-revalidate, max-age=0");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("a valid session passes through untouched: no cookie written, no redirect, the request continues", async () => {
    const res = await proxy(req(`${SESSION}=valid`));
    expect(auth.calls).toBe(1);
    expect(res.cookies.getAll()).toEqual([]);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");             // NextResponse.next(): the page renders
    expect(res.headers.get("location")).toBeNull();
  });

  it("signed out: nothing is written and nothing is decided (pages keep their own checks)", async () => {
    const res = await proxy(req());
    expect(res.cookies.getAll()).toEqual([]);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).toBe(200);
  });

  it("runs on pages, API and auth routes; not on build files, image optimisation or static files", () => {
    const runs = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const url of ["/", "/me", "/staff/batroun", "/admin/payments", "/bookings/abc", "/api/pay/simulate", "/auth/callback?code=1", "/login"])
      expect(runs(url), url).toBe(true);
    for (const url of ["/_next/static/chunks/app.js", "/_next/image?url=x", "/favicon.ico", "/icon.png", "/manifest.webmanifest", "/icons/icon-192.png", "/demo.jpg"])
      expect(runs(url), url).toBe(false);
  });
});
