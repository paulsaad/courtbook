import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ClubSettings from "@/components/ClubSettings";

export default async function AdminClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const { data: club } = await supabase.from("clubs").select("*").eq("slug", slug).single();
  if (!club) notFound();
  const [{ data: courts }, { data: rules }, { data: staff }] = await Promise.all([
    supabase.from("courts").select("*").eq("club_id", club.id).order("sort"),
    supabase.from("price_rules").select("*").eq("club_id", club.id).order("start_time"),
    supabase.rpc("club_staff_list", { p_club: club.id }),
  ]);
  return <ClubSettings club={club} courts={courts ?? []} rules={rules ?? []} staff={(staff ?? []) as { profile_id: string; name: string | null; email: string }[]} isAdmin backHref="/admin" />;
}
