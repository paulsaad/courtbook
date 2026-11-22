import { createClient } from "@/lib/supabase/server";

/** The staging Supabase project: the only database a deployment with test errors may be connected to. */
export const STAGING_SUPABASE_HOST = "pwznauyioqykdwodwpvx.supabase.co";

/**
 * Deliberate test errors are allowed only where explicitly approved (review correction, 22 Nov 2026): a Vercel
 * Preview deployment (staging on m3-dev, or a branch preview) that is connected to the staging database. Everything
 * else — production, a local or unknown environment, a preview pointed at any other database — answers 404, as if
 * the test page and route did not exist. A signed-in admin is required on top of this.
 */
export function testErrorsAllowed(
  vercelEnv = process.env.VERCEL_ENV,
  supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL,
): boolean {
  if (vercelEnv !== "preview") return false;
  try {
    const url = new URL(supabaseUrl ?? "");
    return url.protocol === "https:" && url.host === STAGING_SUPABASE_HOST;
  } catch {
    return false;
  }
}

export async function isAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase.from("profiles").select("roles").eq("id", user.id).maybeSingle();
  return !!data?.roles?.includes("admin");
}
