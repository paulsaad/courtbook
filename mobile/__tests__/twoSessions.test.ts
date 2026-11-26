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
import { signOutAllDevices, signOutThisDevice } from "../lib/signOut";
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

it("no connection: Sign out still signs this phone out (the session is removed before the revoke request)", async () => {
  const phone = await device();
  await auth.close();                                                 // nothing answers: the phone is offline
  await signOutThisDevice(phone);
  expect((await phone.getSession()).data.session).toBeNull();
  expect(auth.alive()).toHaveLength(1);                               // not revoked on the server: valid until revoked (by default it never expires)
  auth = await startFakeAuth();
});

it("control: no connection with the previous call (global): the phone stayed signed in", async () => {
  const phone = await device();
  await auth.close();
  const { error } = await phone.signOut();
  expect(error).toBeTruthy();
  expect((await phone.getSession()).data.session).not.toBeNull();
  auth = await startFakeAuth();
});

it("Sign out of all devices (F2 review S3): every session ends on the server; the desk cannot renew; its issued access token is not revoked", async () => {
  const phone = await device(), desk = await device();
  const deskToken = (await desk.getSession()).data.session!.access_token;
  expect(await signOutAllDevices(phone)).toEqual({ ok: true });
  expect(scopes()).toEqual(["global", "local"]);   // revoked everywhere (confirmed by the server), then this phone cleared
  expect(auth.alive()).toHaveLength(0);
  expect((await phone.getSession()).data.session).toBeNull();
  expect((await desk.refreshSession()).error).toBeTruthy();
  // not revoked: a signed token, unexpired, accepted by the database until it expires (Supabase default 1 h)
  const exp = JSON.parse(Buffer.from(deskToken.split(".")[1], "base64url").toString()).exp;
  expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3000);
});

it("Sign out of all devices with no connection: ok=false, nothing changed, this phone still signed in", async () => {
  const phone = await device();
  await auth.close();
  expect(await signOutAllDevices(phone)).toEqual({ ok: false, reason: "failed" });
  expect((await phone.getSession()).data.session).not.toBeNull();
  auth = await startFakeAuth();
});

// re-review R103-1: auth-js's global sign-out treats these answers as "already signed out" and reports success
for (const [status, code] of [[401, "no_authorization"], [403, "bad_jwt"], [404, "not_found"]] as const) {
  it(`Sign out of all devices, /logout answers ${status} ${code}: not done; this phone kept; the desk still signed in`, async () => {
    const phone = await device(), desk = await device();
    auth.logoutAnswer = { status, code };
    expect(await signOutAllDevices(phone)).toEqual({ ok: false, reason: "failed" });
    expect((await phone.getSession()).data.session).not.toBeNull();
    auth.logoutAnswer = null;
    expect(auth.alive()).toHaveLength(2);
    expect((await desk.refreshSession()).error).toBeNull();
  });
}
it("Sign out of all devices when this phone's own session already ended on the server: this_device_ended; the desk lives", async () => {
  const phone = await device(), desk = await device();
  auth.sessions[0].revoked = true;
  expect(await signOutAllDevices(phone)).toEqual({ ok: false, reason: "this_device_ended" });
  expect((await desk.refreshSession()).error).toBeNull();
});
