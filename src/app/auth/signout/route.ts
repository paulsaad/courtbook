import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Ordinary sign-out (F2, Paul 26 Nov): ends THIS browser's session only. The person's other devices stay signed in.
 * Ending every session is for account closure (api/account/close, scope "global") and explicit security actions.
 * Local sign-out clears this browser's session cookies before it asks Supabase Auth to revoke this session's refresh
 * token, so this browser is signed out even if Supabase Auth cannot be reached from the server (auth-js 2.119; the
 * session then stays valid on the Auth server until it expires). This route runs on the server: a browser with no
 * connection cannot reach it at all, and stays signed in, as before F2.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
