import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PaymentsDashboard, { type PaymentRow, type RefundRow, type Summary } from "@/components/PaymentsDashboard";

export default async function AdminPayments({ searchParams }: { searchParams: Promise<{ month?: string; club?: string }> }) {
  const { month: qMonth, club: qClub } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/payments");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const month = qMonth && /^\d{4}-\d{2}$/.test(qMonth) ? qMonth : new Date().toISOString().slice(0, 7);
  const [{ data: summary }, { data: refunds }] = await Promise.all([
    supabase.rpc("payments_summary", { p_month: `${month}-01` }),
    supabase.rpc("refunds_due"),
  ]);
  const clubId = qClub ?? ((summary ?? []) as Summary[])[0]?.club_id ?? null;
  const { data: rows } = clubId ? await supabase.rpc("payments_list", { p_club: clubId, p_month: `${month}-01` }) : { data: null };

  return (
    <PaymentsDashboard month={month} summary={(summary ?? []) as Summary[]} refunds={(refunds ?? []) as RefundRow[]} rows={rows as PaymentRow[] | null} clubId={clubId} backHref="/admin" title="Payments" basePath="/admin/payments" />
  );
}
