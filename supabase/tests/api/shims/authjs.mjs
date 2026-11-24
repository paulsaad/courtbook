// @supabase/supabase-js for src/lib/supabase/bearer.ts in the local harness. The local stack has PostgREST but no
// Supabase Auth server, so auth.getUser(token) is answered here the way Auth answers it: the token's HS256 signature
// must verify with the project's JWT secret, it must not be expired, its role must be 'authenticated' and it must
// name a user that exists in auth.users. Everything else is the real supabase-js client (the database calls are real).
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as real from "@supabase/supabase-js";
const require = createRequire(import.meta.url);
const { Client } = require(`${process.env.PG_MODULE ?? "/tmp/pgdeps/node_modules"}/pg`);
const env = Object.fromEntries(readFileSync("/tmp/courtbook-api/env", "utf8").trim().split("\n").map((l) => l.split("=")));

async function userFor(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) return null;
  const want = createHmac("sha256", env.API_JWT_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let claims; try { claims = JSON.parse(Buffer.from(p, "base64url").toString()); } catch { return null; }
  if (claims.role !== "authenticated" || !claims.sub || !(claims.exp > Date.now() / 1000)) return null;
  const db = new Client({ connectionString: `postgresql:///${env.API_DB}?host=/var/run/postgresql` });
  await db.connect();
  try { return (await db.query("select id from auth.users where id = $1", [claims.sub])).rows[0] ? { id: claims.sub } : null; }
  finally { await db.end(); }
}

export function createClient(url, key, opts) {
  const c = real.createClient(url, key, opts);
  c.auth.getUser = async (jwt) => {
    globalThis.__authAsked = (globalThis.__authAsked ?? 0) + 1;
    const user = await userFor(jwt);
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
  };
  return c;
}
