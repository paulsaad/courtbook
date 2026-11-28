/**
 * F1: moves a booking only if it is still where this sheet saw it (the database compares under the booking's lock).
 * Rollout: this website goes live before the database change. Until the change is applied the database has only
 * 0091's call, and PostgREST answers PGRST202 ("no function with these arguments"); the page then makes 0091's call,
 * exactly as before. Once the change is applied, 0091's call refuses every move, so this fallback can never skip the
 * comparison (also while PostgREST's schema cache is stale just after the change: tested against real PostgREST in
 * supabase/tests/api/f1_rollout.mjs). Remove it once the change is live on every database.
 */
export type MoveArgs = { p_booking: string; p_court: string; p_start: string; p_end: string; p_expected_price: number | null };
export type SeenArgs = { p_seen_court: string | null; p_seen_start: string; p_seen_end: string };
type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };

export async function moveBooking(db: Rpc, args: MoveArgs, seen: SeenArgs) {
  const r = await db.rpc("move_booking_priced", { ...args, ...seen });
  if (r.error?.code === "PGRST202") return db.rpc("move_booking_priced", args);
  return r;
}
