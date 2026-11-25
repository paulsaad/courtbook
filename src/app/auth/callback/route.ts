import { NextResponse } from "next/server";
import { safeNextPath } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";
import { reportAuthError } from "@/lib/report";

// Magic-link landing: exchanges the code for a session cookie, then goes home.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const safeNext = safeNextPath(next);
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${safeNext}`);
    await reportAuthError("authCodeExchange", error, true);
  }
  return NextResponse.redirect(`${origin}/login?error=link`);
}
