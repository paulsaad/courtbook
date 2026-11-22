import { createClient } from "@/lib/supabase/server";

/** Deliberate test errors are allowed on staging and previews only, and only for a signed-in admin. On production
 *  the test page and route answer 404, as if they did not exist (W2a review correction, 22 Nov 2026). */
export function testErrorsAllowed(vercelEnv = process.env.VERCEL_ENV): boolean {
  return vercelEnv !== "production";
}

export async function isAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("profiles").select("roles").eq("id", user.id).maybeSingle();
  return !!data?.roles?.includes("admin");
}
