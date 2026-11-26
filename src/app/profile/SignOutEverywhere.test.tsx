// @vitest-environment jsdom
/**
 * F2 review S3 (Paul, 26 Nov): Profile → "Sign out of all devices", with a confirmation. Two independent browser
 * sessions of one fictional account, the real @supabase/ssr client and auth-js 2.119, against the local stand-in for
 * Supabase Auth (../auth/signout/fakeAuthServer.ts). Shows what is revoked and what is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createServerClient } from "@supabase/ssr";
import { startFakeAuth, type FakeAuth } from "../auth/signout/fakeAuthServer";
import { SIGN_OUT_ALL } from "@/lib/signOutText";

type Jar = Map<string, string>;
const env = vi.hoisted(() => ({ auth: null as null | { url: string }, jar: null as null | Map<string, string>, browser: null as unknown, replace: vi.fn() }));
const client = (jar: Jar) => createServerClient(env.auth!.url, "anon-test", {
  cookies: {
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (cs) => cs.forEach(({ name, value }) => { if (value) jar.set(name, value); else jar.delete(name); }),
  },
});
// the website's browser client is created once per page and reused (createBrowserClient's singleton): the same here
vi.mock("@/lib/supabase/client", () => ({ createClient: () => env.browser }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: env.replace, refresh: vi.fn() }) }));
import SignOutEverywhere from "./SignOutEverywhere";

let auth: FakeAuth;
/** a device signs in; its one client stays its page's client (one per browser, as on the website) */
const clients = new Map<Jar, ReturnType<typeof client>>();
async function signIn(): Promise<Jar> {
  const jar: Jar = new Map();
  const c = client(jar);
  const { error } = await c.auth.signInWithPassword({ email: "rana@example.test", password: "local-test-only" });
  if (error) throw error;
  clients.set(jar, c);
  return jar;
}
/** this browser's one client, initialised (as on a page that has been open a moment) */
async function useBrowser(jar: Jar) { env.jar = jar; env.browser = clients.get(jar); }
const tokens = (jar: Jar) => [...jar.keys()].filter((k) => k.includes("auth-token"));
const scopes = () => auth.requests.filter((r) => r.path.startsWith("/auth/v1/logout")).map((r) => new URL(r.path, "http://x").searchParams.get("scope"));
/** the access token a device holds, and when it expires (seconds left) */
async function accessTokenLeft(jar: Jar) {
  const { data } = await clients.get(jar)!.auth.getSession();
  const t = data.session?.access_token;
  if (!t) return null;
  return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp - Math.floor(Date.now() / 1000);
}

beforeEach(async () => { auth = await startFakeAuth(); env.auth = auth; env.replace.mockReset(); });
afterEach(async () => { cleanup(); await auth.close().catch(() => {}); });

describe("F2 S3: Sign out of all devices — confirmation", () => {
  it("nothing happens until confirmed; Cancel changes nothing", async () => {
    const phone = await signIn(); await useBrowser(phone);
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.button));
    expect(screen.getByRole("heading").textContent).toBe(SIGN_OUT_ALL.title);
    expect(screen.getByText(SIGN_OUT_ALL.body)).toBeTruthy();
    expect(scopes()).toEqual([]);
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.cancel));
    expect(screen.queryByRole("heading")).toBeNull();
    expect(scopes()).toEqual([]);
    expect(auth.alive()).toHaveLength(1);
  });
});

describe("F2 S3: what 'Sign out everywhere' revokes, with two real sessions", () => {
  it("every session ends on the Auth server; this browser is signed out at once; the desk can no longer renew", async () => {
    const desk = await signIn(), phone = await signIn(); await useBrowser(phone);
    const deskTokenBefore = await accessTokenLeft(desk);
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.button));
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.confirm));
    await waitFor(() => expect(env.replace).toHaveBeenCalledWith("/"));
    expect(scopes()).toEqual(["global", "local"]);                         // revoked everywhere, confirmed; then this browser cleared
    expect(auth.alive()).toHaveLength(0);                                  // every session revoked on the server
    expect(tokens(phone)).toEqual([]);                                     // this browser: signed out now
    expect((await clients.get(desk)!.auth.refreshSession()).error).toBeTruthy();  // the desk cannot renew
    // NOT revoked: the desk's already-issued access token is a signed token, still unexpired (it is accepted by the
    // database until it expires; Supabase's default lifetime 1 h). Never claimed as immediate.
    expect(deskTokenBefore).toBeGreaterThan(3000);
  });

  // re-review R103-1: auth-js's own global sign-out treats these answers as "already signed out", clears this browser
  // and reports success although nothing was revoked. The page must never say everything was signed out then.
  for (const [status, code] of [[401, "no_authorization"], [403, "bad_jwt"], [404, "not_found"]] as const) {
    it(`/logout answers ${status} ${code}: not reported as done; this browser stays signed in; the desk's session lives`, async () => {
      const desk = await signIn(), phone = await signIn(); await useBrowser(phone);
      auth.logoutAnswer = { status, code };
      render(<SignOutEverywhere />);
      fireEvent.click(screen.getByText(SIGN_OUT_ALL.button));
      fireEvent.click(screen.getByText(SIGN_OUT_ALL.confirm));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_ALL.failed));
      expect(env.replace).not.toHaveBeenCalled();
      expect(tokens(phone).length).toBeGreaterThan(0);
      expect(auth.alive()).toHaveLength(2);
      auth.logoutAnswer = null;
      expect((await clients.get(desk)!.auth.refreshSession()).error).toBeNull();
    });
  }
  it("this browser's own session already ended on the server (desk still signed in): says so, never 'done'", async () => {
    const desk = await signIn(), phone = await signIn(); await useBrowser(phone);
    auth.sessions[1].revoked = true;                                   // the phone's session, ended elsewhere
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.button));
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.confirm));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_ALL.thisDeviceEnded));
    expect(env.replace).not.toHaveBeenCalled();
    expect(auth.alive()).toHaveLength(1);
    expect((await clients.get(desk)!.auth.refreshSession()).error).toBeNull();
  });

  it("Auth unreachable (offline): nothing changes anywhere, the page says so, this browser stays signed in", async () => {
    const desk = await signIn(), phone = await signIn(); await useBrowser(phone);
    await auth.close();
    render(<SignOutEverywhere />);
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.button));
    fireEvent.click(screen.getByText(SIGN_OUT_ALL.confirm));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(SIGN_OUT_ALL.failed));
    expect(env.replace).not.toHaveBeenCalled();
    expect(tokens(phone).length).toBeGreaterThan(0);                       // not a silent this-browser-only sign-out
    expect(auth.alive()).toHaveLength(2);
    expect(tokens(desk).length).toBeGreaterThan(0);
  });
});
