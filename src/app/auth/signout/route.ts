import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Ordinary sign-out (F2, Paul 26 Nov): ends THIS browser's session only. The person's other devices stay signed in.
 * Ending every session is for account closure (api/account/close, scope "global") and explicit security actions.
 * Local sign-out clears this browser's cookies before it asks Supabase Auth to revoke this session's refresh token, so
 * it works offline too (auth-js 2.119: a failed revoke still signs this browser out).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
