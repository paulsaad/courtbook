import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export default async function AdminPayments() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/payments");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <Link href="/admin" className="text-sm text-muted">‹ Clubs</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
      <p className="text-muted">Coming in Phase 3 step 3: refunds due, fees earned, club payouts, CSV export.</p>
    </main>
  );
}
