import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Keeps the signed-in session fresh (website completion W1, audit B1) — Supabase's documented Next.js setup.
 *
 * Server pages cannot store cookies, so when the one-hour access token has expired a page would renew it in
 * memory, fail to save it, and leave the browser holding a spent refresh token. This runs before every page and
 * route: if the session needs renewing it is renewed here, the new cookies are handed to the page being rendered
 * (request cookies) and sent to the browser (response cookies), with the no-cache headers Supabase supplies so a
 * response carrying a session is never cached for someone else.
 *
 * It decides nothing: no redirects, no access checks. Pages and the database keep every check they have.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    },
  );
  // Nothing may run between creating the client and this call (Supabase's guidance): it renews an expired
  // session and verifies the token. Its result is not used for any decision here.
  await supabase.auth.getClaims();
  return response;
}

export const config = {
  // every page and route, except build files, image optimisation and static files
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
