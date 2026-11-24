import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Service-role client. Server only. Bypasses RLS: use for confirm_payment / fail_payment, for writing to the
 *  club-media bucket (no client write policy), and for account-deletion processing (M2, 0086: src/lib/deletion,
 *  only after the route has established who may ask — the person themselves, an admin, or the CRON_SECRET caller).
 *  Nothing else. `timeoutMs` aborts each request after that long (deletion processing uses it). */
export function createAdminClient(opts: { timeoutMs?: number } = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  const t = opts.timeoutMs;
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(t ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(t) }) } } : {}),
  });
}
