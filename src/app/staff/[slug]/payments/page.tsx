import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PaymentsDashboard, { type PaymentRow, type RefundRow, type Summary } from "@/components/PaymentsDashboard";

export default async function StaffPayments({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ month?: string }> }) {
  const { slug } = await params;
  const { month: qMonth } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: club } = await supabase.from("clubs").select("id, name").eq("slug", slug).single();
  if (!club) notFound();

  const month = qMonth && /^\d{4}-\d{2}$/.test(qMonth) ? qMonth : new Date().toISOString().slice(0, 7);
  const [{ data: summary }, { data: refunds }, { data: rows }] = await Promise.all([
    supabase.rpc("payments_summary", { p_month: `${month}-01` }),
    supabase.rpc("refunds_due"),
    supabase.rpc("payments_list", { p_club: club.id, p_month: `${month}-01` }),
  ]);
  const mine = ((summary ?? []) as Summary[]).filter((s) => s.club_id === club.id);
  if (mine.length === 0) return <main className="p-6">You are not staff at {club.name}.</main>;

  return (
    <PaymentsDashboard month={month} summary={mine} refunds={((refunds ?? []) as RefundRow[]).filter((r) => r.club_name === club.name)} rows={rows as PaymentRow[]} clubId={club.id} backHref={`/staff/${slug}`} title={`${club.name} payments`} basePath={`/staff/${slug}/payments`} />
  );
}
