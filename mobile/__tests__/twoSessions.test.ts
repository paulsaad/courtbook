/**
 * @jest-environment node
 *
 * F2 (Paul, 26 Nov): two independent sessions of one fictional account (this phone and a desk browser), the real
 * @supabase/auth-js the app ships (2.119), and a local stand-in for Supabase Auth (the website's test server,
 * src/app/auth/signout/fakeAuthServer.ts). The Profile screen's sign-out ends this phone only; closing the account
 * (lib/accountClosing.ts) still ends every session.
 */
/// <reference types="node" />
import { request, type IncomingMessage } from "node:http";
import { AuthClient as GoTrueClient } from "@supabase/supabase-js";   // auth-js, as the app ships it
import { startFakeAuth, type FakeAuth } from "../../src/app/auth/signout/fakeAuthServer";
import { signOutThisDevice } from "../lib/signOut";
import { closeMyAccount } from "../lib/accountClosing";

let auth: FakeAuth;
// the test environment replaces fetch with React Native's; this one talks to the local server directly
const nodeFetch = (input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
  const req = request(String(input), { method: init.method ?? "GET", headers: init.headers as Record<string, string> }, (res: IncomingMessage) => {
    let d = ""; res.on("data", (c: Buffer) => { d += c; });
    res.on("end", () => resolve(new Response(d || null, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "") } })));
  });
  req.on("error", reject);
  if (init.body) req.write(init.body as string);
  req.end();
});
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; };
async function device() {
  const c = new GoTrueClient({ url: `${auth.url}/auth/v1`, headers: { apikey: "anon-test" }, fetch: nodeFetch as typeof fetch, storage: memory(), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false });
  const { error } = await c.signInWithPassword({ email: "rana@example.test", password: "local-test-only" });
  if (error) throw error;
  return c;
}
async function signedIn(c: InstanceType<typeof GoTrueClient>) {
  const { data } = await c.getSession();
  if (!data.session) return { session: false, refreshed: false };
  return { session: true, refreshed: !(await c.refreshSession()).error };
}
const scopes = () => auth.requests.filter((r) => r.path.startsWith("/auth/v1/logout")).map((r) => new URL(r.path, "http://x").searchParams.get("scope"));

beforeEach(async () => { auth = await startFakeAuth(); });
afterEach(async () => { await auth.close(); });

it("Sign out on the phone: the phone is signed out, the desk browser keeps its session and can refresh it", async () => {
  const phone = await device(), desk = await device();
  await signOutThisDevice(phone);
  expect(scopes()).toEqual(["local"]);
  expect(await signedIn(phone)).toEqual({ session: false, refreshed: false });
  expect(await signedIn(desk)).toEqual({ session: true, refreshed: true });
  expect(auth.alive()).toHaveLength(1);
});

it("closing the account on the phone signs the desk browser out as well (global)", async () => {
  const phone = await device(), desk = await device();
  const rpc = async () => ({ data: null, error: null });   // close_my_account committed (tested in the database suites)
  expect(await closeMyAccount(rpc, (o) => phone.signOut(o))).toEqual({ ok: true });
  expect(scopes()).toEqual(["global"]);
  expect(auth.alive()).toHaveLength(0);
  expect((await desk.refreshSession()).error).toBeTruthy();
  expect(await signedIn(phone)).toEqual({ session: false, refreshed: false });
});

it("control: the previous call (no scope = global) ended the desk browser's session too", async () => {
  const phone = await device(), desk = await device();
  await phone.signOut();
  expect(scopes()).toEqual(["global"]);
  expect((await desk.refreshSession()).error).toBeTruthy();
});
