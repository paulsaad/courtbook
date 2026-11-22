import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Service-role client. Server only. Bypasses RLS: use for confirm_payment / fail_payment, for writing to the
 *  club-media bucket (no client write policy), and for deleting a sign-in account in /api/admin/delete-account
 *  (M2; the database steps there run with the admin's own session). Nothing else. */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
