import type { SupabaseClient } from "@supabase/supabase-js";
import { safeNextPath } from "./safeNext";
import { loaded } from "@/lib/load";

/**
 * Where a signed-in person must go before player activity (booking, games, chat), or null when they are ready:
 *   1. no name yet → the first-time profile step (games and chat only: other players see the name there; browsing
 *      clubs and courts is not blocked — a court booking asks for the name and contact phone at Reserve, /details);
 *   2. not confirmed 18 or over (0080) → /age.
 * `next` is where to come back to (a path on this site). Before 0080 exists the age step is skipped. The database
 * enforces the age rule itself (require_age_confirmed); this only sends people to the right page first.
 */
export async function playerGatePath(supabase: SupabaseClient, userId: string, next: string, what = "this page", opts: { requireName?: boolean } = {}): Promise<string | null> {
  const back = encodeURIComponent(safeNext(next));
  if (opts.requireName !== false) {
    const { data: me } = loaded(await supabase.from("profiles").select("name").eq("id", userId).single(), what);
    if (!me?.name) return `/profile?next=${back}`;
  }
  const res = await supabase.rpc("my_age_status");
  if (res.error && isMissingFunction(res.error)) return null;          // before 0080: no age step yet
  const s = loaded(res, what).data as { confirmed?: boolean } | null;  // any other failure stops the page (W1)
  return s && s.confirmed === false ? `/age?next=${back}` : null;
}

/** PostgREST's answer for a function that is not in the database (before its migration, or after a rollback). */
export function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? ""));
}

/** Only a path on this site: anything else (another host, "//host", "/\\host", "/<tab>/host", a scheme) becomes "/". */
export function safeNext(next: string | null | undefined): string {
  return safeNextPath(next);
}

/** The club page's own address with the player's selection (date, time, court, length), to come back to. */
export function clubReturnPath(slug: string, p: { date?: string; at?: string; court?: string; dur?: string }): string {
  const q = new URLSearchParams();
  for (const k of ["date", "at", "court", "dur"] as const) { const v = p[k]; if (v) q.set(k, v); }
  return `/club/${slug}${q.size ? `?${q}` : ""}`;
}
