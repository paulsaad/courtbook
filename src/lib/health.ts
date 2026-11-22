import { createClient as createSupabase } from "@supabase/supabase-js";

/** The column read: `sports` is keyed by `code` (migration 0029). Checked against the migrations in health.test.ts. */
export const HEALTH_COLUMN = "code";

/** The database answers a public read (one row of `sports`, readable by anyone, 0032) within the time limit.
 *  No cookies and no session: the same view a signed-out visitor has. */
export async function databaseReachable(
  timeoutMs = 3000,
  make = () => createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }),
): Promise<boolean> {
  try {
    const { error } = await make().from("sports").select(HEALTH_COLUMN).limit(1).abortSignal(AbortSignal.timeout(timeoutMs));
    return !error;
  } catch {
    return false;
  }
}
