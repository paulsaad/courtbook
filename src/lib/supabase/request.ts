import { createClient as createTokenClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createClient as createCookieClient } from "./server";

/**
 * Who is making this request, for routes called by both the website and the phone app.
 *
 * - No Authorization header: the website. The cookie session is read exactly as before.
 * - "Authorization: Bearer <access token>": the app. The token is checked by Supabase Auth
 *   (auth.getUser(token) — signature, expiry, and that the user still exists); a token that merely
 *   decodes is not enough. The returned client sends that token with every query, so row-level
 *   security applies to the app's request exactly as it does to the browser's.
 * - A header that is present but is not a valid bearer token (malformed, expired, "Basic …"): 401.
 *   It never falls back to the cookie: one request, one identity.
 *
 * Nothing here reads an identity from the body, the query string or any other header. Routes take
 * the user only from what this returns.
 */
export type RequestAuth =
  | { ok: true; user: User; supabase: SupabaseClient; via: "cookie" | "bearer" }
  | { ok: false; status: 401; error: "not_authenticated" | "invalid_authorization" };

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/;

export async function authenticateRequest(request: Request): Promise<RequestAuth> {
  const header = request.headers.get("authorization");

  if (header !== null) {
    const match = BEARER.exec(header.trim());
    if (!match) return { ok: false, status: 401, error: "invalid_authorization" };
    const token = match[1];
    const supabase = createTokenClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return { ok: false, status: 401, error: "invalid_authorization" };
    return { ok: true, user: data.user, supabase, via: "bearer" };
  }

  const supabase = await createCookieClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "not_authenticated" };
  return { ok: true, user, supabase, via: "cookie" };
}
