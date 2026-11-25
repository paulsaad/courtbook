/**
 * The staff calendar's payment read (review 24 Nov). Staff may read their club's payments (RLS: "payments: read own or
 * club staff"). Read on its own, after the bookings: if it fails, the bookings still show, each with an unknown payment,
 * which the calendar labels "payment status not loaded" — never "paid in the app".
 */
type Reader = {
  from: (t: "payments") => { select: (c: string) => { in: (col: string, v: string[]) => PromiseLike<{ data: unknown; error: unknown }> } };
};
export async function paymentsByBooking<T extends { id: string }>(supabase: Reader, rows: T[]): Promise<(T & { payments?: { status: string; kind?: string } | null })[]> {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return rows;
  let res: { data: unknown; error: unknown };
  try { res = await supabase.from("payments").select("booking_id, status, kind").in("booking_id", ids); }
  catch { return rows.map((r) => ({ ...r, payments: undefined })); }
  if (res.error || !Array.isArray(res.data)) return rows.map((r) => ({ ...r, payments: undefined }));
  // kind (M12.1): a fee-only payment means the court is still due at the desk
  const by = new Map((res.data as { booking_id: string; status: string; kind?: string }[]).map((p) => [p.booking_id, p.kind ? { status: p.status, kind: p.kind } : { status: p.status }]));
  return rows.map((r) => ({ ...r, payments: by.get(r.id) ?? null }));
}
