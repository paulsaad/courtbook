// Clients for the local API: each signed in the way Supabase Auth signs a session (sub, role, amr with the sign-in
// time), or the service key. Uses the repository's own @supabase/supabase-js.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(readFileSync("/tmp/courtbook-api/env", "utf8").trim().split("\n").map((l) => l.split("=")));
export const API_URL = env.API_URL, API_DB = env.API_DB;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function jwt(claims) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + 3600, aud: "authenticated", ...claims };
  const head = b64({ alg: "HS256", typ: "JWT" }), pay = b64(body);
  const sig = createHmac("sha256", env.API_JWT_SECRET).update(`${head}.${pay}`).digest("base64url");
  return `${head}.${pay}.${sig}`;
}
export const ANON_KEY = jwt({ role: "anon" });
const opts = (token) => ({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
/** A signed-in person; signedInAgo seconds since their sign-in (amr), as Supabase sets it. */
export const asUser = (id, signedInAgo = 0) => createClient(API_URL, ANON_KEY,
  opts(jwt({ sub: id, role: "authenticated", amr: [{ method: "otp", timestamp: Math.floor(Date.now() / 1000) - signedInAgo }], session_id: randomUUID() })));
export const asAnon = () => createClient(API_URL, ANON_KEY, opts(ANON_KEY));
export const asService = () => createClient(API_URL, ANON_KEY, opts(jwt({ role: "service_role" })));
