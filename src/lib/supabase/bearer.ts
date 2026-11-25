import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * The signed-in player behind an app request (M12.4). The app sends its Supabase access token in
 * `Authorization: Bearer <token>` — never in a URL, a body or a cookie. The token is checked with Supabase Auth
 * (getUser asks the Auth server, so an expired, revoked or forged token is refused), then a database client is built
 * that acts as that player: row-level security and auth.uid() apply exactly as they do in the app itself.
 *
 * Nothing here logs or returns the token. A missing or malformed header is refused without asking Auth.
 */
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const clientFor = (url: string, anon: string, token: string) => createSupabaseClient(url, anon, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});

export type BearerPlayer = { userId: string; player: ReturnType<typeof clientFor> };

export function bearerToken(header: string | null): string | null {
  if (!header || header.length > 8192) return null;
  const m = /^Bearer (\S+)$/.exec(header);
  return m && JWT.test(m[1]) ? m[1] : null;
}

export async function playerFromBearer(request: Request): Promise<BearerPlayer | null> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  const player = clientFor(url, anon, token);
  let user;
  try { ({ data: { user } } = await player.auth.getUser(token)); } catch { return null; }
  if (!user?.id) return null;
  return { userId: user.id, player };
}
