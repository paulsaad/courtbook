/**
 * F2 (Paul, 26 Nov): ordinary sign-out ends only the current device's session; account closure still ends every
 * session. Two independent browser sessions of one fictional account (two cookie jars), our real routes, the real
 * @supabase/ssr and @supabase/auth-js, against a local stand-in for Supabase Auth (fakeAuthServer.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import { startFakeAuth, type FakeAuth } from "./fakeAuthServer";

type Jar = Map<string, string>;
const devices = vi.hoisted(() => ({ current: null as null | Map<string, string> }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...(devices.current ?? new Map()).entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => { if (value) devices.current!.set(name, value); else devices.current!.delete(name); },
  }),
}));
// closure's later steps (B–E) run with the service key; they are tested in deletionRoutes and the pipeline suites
vi.mock("@/lib/deletion/pipeline", () => ({ processDeletion: vi.fn(async () => ({ result: "done" })), serviceDeps: vi.fn(async () => ({})), dbCode: () => "" }));
vi.mock("@/lib/report", () => ({ report: vi.fn(async () => {}) }));

import { POST as signOutRoute } from "./route";
import { POST as closeRoute } from "../../api/account/close/route";

let auth: FakeAuth;
const client = (jar: Jar) => createServerClient(auth.url, "anon-test", {
  cookies: {
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (cs) => cs.forEach(({ name, value }) => { if (value) jar.set(name, value); else jar.delete(name); }),
  },
});
/** a device signs in: its own session, kept in its own cookies */
async function signIn(): Promise<Jar> {
  const jar: Jar = new Map();
  const { error } = await client(jar).auth.signInWithPassword({ email: "rana@example.test", password: "local-test-only" });
  if (error) throw error;
  return jar;
}
/** is this device still signed in? (its access token's session, and a refresh with its refresh token) */
async function signedIn(jar: Jar) {
  const c = client(jar);
  const user = (await c.auth.getUser()).data.user?.id ?? null;
  const refreshed = jar.size ? !(await c.auth.refreshSession()).error : false;
  return { user: !!user, refreshed };
}
const as = async <T>(jar: Jar, fn: () => Promise<T>) => { devices.current = jar; try { return await fn(); } finally { devices.current = null; } };
const logoutScopes = () => auth.requests.filter((r) => r.path.startsWith("/auth/v1/logout")).map((r) => new URL(r.path, "http://x").searchParams.get("scope"));

beforeEach(async () => { auth = await startFakeAuth(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", auth.url); vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test"); });
afterEach(async () => { vi.unstubAllEnvs(); await auth.close(); });

describe("F2: Sign out on one device", () => {
  it("ends that device's session only: the desk browser stays signed in and keeps working", async () => {
    const desk = await signIn(), phone = await signIn();
    expect(auth.alive()).toHaveLength(2);

    const res = await as(phone, () => signOutRoute(new Request("http://localhost:3000/auth/signout", { method: "POST" })));
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");

    expect(logoutScopes()).toEqual(["local"]);                       // the request our route sent
    expect([...phone.keys()].filter((k) => k.includes("auth-token"))).toEqual([]);   // the phone's cookies are gone
    expect(await signedIn(phone)).toEqual({ user: false, refreshed: false });
    expect(await signedIn(desk)).toEqual({ user: true, refreshed: true }); // the desk: still signed in, refresh works
    expect(auth.alive()).toHaveLength(1);
  });

  it("control: the previous sign-out (no scope = auth-js's default, global) signed the desk out too", async () => {
    const desk = await signIn(), phone = await signIn();
    await client(phone).auth.signOut();                               // what route.ts did before F2
    expect(logoutScopes()).toEqual(["global"]);
    expect(await signedIn(desk)).toEqual({ user: false, refreshed: false });
  });
});

describe("F2: account closure still ends every session", () => {
  it("closing the account on the phone signs the desk browser out as well", async () => {
    const desk = await signIn(), phone = await signIn();
    const res = await as(phone, () => closeRoute(new Request("http://localhost:3000/api/account/close", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
    })));
    expect(await res.json()).toEqual({ closed: true });
    expect(logoutScopes()).toEqual(["global"]);
    expect(auth.alive()).toHaveLength(0);
    expect(await signedIn(desk)).toEqual({ user: false, refreshed: false });
    expect(await signedIn(phone)).toEqual({ user: false, refreshed: false });
  });
});

describe("F2: when Supabase Auth cannot be reached (what 'local' changes, and what it does not)", () => {
  // A browser with no connection cannot reach /auth/signout at all (a form POST to our server): it stays signed in,
  // before and after F2. These tests cover the server reaching our route but not Supabase Auth.
  it("local: this browser's session cookies are cleared anyway; the server session is not revoked (valid until revoked: by default it never expires)", async () => {
    const phone = await signIn();
    await auth.close();                                               // Supabase Auth unreachable from now on
    const res = await as(phone, () => signOutRoute(new Request("http://localhost:3000/auth/signout", { method: "POST" })));
    expect(res.status).toBe(303);
    expect([...phone.keys()].filter((k) => k.includes("auth-token"))).toEqual([]);
    expect(auth.alive()).toHaveLength(1);                             // never revoked: the request did not arrive
    auth = await startFakeAuth();                                     // for afterEach
  });
  it("control: the previous call (global) left this browser signed in when Auth could not be reached", async () => {
    const phone = await signIn();
    await auth.close();
    await client(phone).auth.signOut();
    expect([...phone.keys()].filter((k) => k.includes("auth-token")).length).toBeGreaterThan(0);
    auth = await startFakeAuth();
  });
});
