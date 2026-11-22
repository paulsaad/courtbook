import { createClient as createSupabase } from "@supabase/supabase-js";

/** The database answers a public read (one row of `sports`, readable by anyone, 0032) within the time limit.
 *  No cookies and no session: the same view a signed-out visitor has. */
export async function databaseReachable(
  timeoutMs = 3000,
  make = () => createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }),
): Promise<boolean> {
  try {
    const { error } = await make().from("sports").select("id").limit(1).abortSignal(AbortSignal.timeout(timeoutMs));
    return !error;
  } catch {
    return false;
  }
}
