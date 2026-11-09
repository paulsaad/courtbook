import { createClient } from "@/lib/supabase/server";

// CSV of a club's payments for a month. Uses the caller's session: the RPC only returns
// rows for clubs the caller staffs.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const club = searchParams.get("club");
  const month = searchParams.get("month");
  if (!club || !month || !/^\d{4}-\d{2}$/.test(month)) return new Response("club and month=YYYY-MM required", { status: 400 });

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("not authenticated", { status: 401 });

  const { data, error } = await supabase.rpc("payments_list", { p_club: club, p_month: `${month}-01` });
  if (error) return new Response(error.message, { status: 400 });

  const cols = ["payment_id", "booking_id", "status", "provider", "provider_ref", "player_name", "court_name", "start_at", "end_at", "amount_usd", "fee_usd", "total_usd", "paid_at", "refunded_at", "note"];
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(","), ...((data ?? []) as Record<string, unknown>[]).map((r) => cols.map((c) => esc(r[c])).join(","))];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="payments-${month}.csv"` },
  });
}
