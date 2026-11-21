import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import NewClubForm from "./NewClubForm";
import WorkNav from "@/components/WorkNav";

export default async function AdminHome() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  // open reports and feedback (0074); before 0074 the function is missing and no count is shown
  const { data: open } = await supabase.rpc("admin_reports", { p_status: "open" });
  const openCount = Array.isArray(open) ? open.length : null;
  const { data: clubs } = await supabase.from("clubs").select("id, name, slug, active, service_fee_usd, courts(count)").order("name");

  return (
    <>
    <WorkNav area="admin" active="clubs" />
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5">
      <Link href="/" className="text-sm text-muted">‹ Home</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Clubs</h1>
      <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">
        {(clubs ?? []).map((c) => (
          <li key={c.id}>
            <Link href={`/admin/clubs/${c.slug}`} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-muted">{(c.courts as unknown as { count: number }[])[0]?.count ?? 0} courts · fee ${Number(c.service_fee_usd).toFixed(2)}{c.active ? "" : " · inactive"}</div>
              </div>
              <span className="text-muted">›</span>
            </Link>
          </li>
        ))}
      </ul>
      <NewClubForm />
      <div className="flex gap-4">
        <Link href="/admin/payments" className="text-sm text-action underline">Payments</Link>
        <Link href="/admin/reports" className="text-sm text-action underline">Reports{openCount ? ` (${openCount} open)` : ""}</Link>
      </div>
    </main>
    </>
  );
}
