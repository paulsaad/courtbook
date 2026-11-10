import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ClubSettings from "@/components/ClubSettings";
import { loadRefData, loadTown } from "@/lib/geo";

export default async function AdminClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const { data: club } = await supabase.from("clubs").select("*").eq("slug", slug).single();
  if (!club) notFound();
  const [{ data: courts }, { data: rules }, { data: staff }, { data: coachReqs }, ref, town] = await Promise.all([
    supabase.from("courts").select("*").eq("club_id", club.id).order("sort"),
    supabase.from("price_rules").select("*").eq("club_id", club.id).order("start_time"),
    supabase.rpc("club_staff_list", { p_club: club.id }),
    supabase.rpc("club_coach_requests", { p_club: club.id }),
    loadRefData(supabase),
    loadTown(supabase, club.town_id ?? null),
  ]);
  return <ClubSettings club={club} courts={courts ?? []} rules={rules ?? []} staff={(staff ?? []) as { profile_id: string; name: string | null; email: string }[]} coaches={(coachReqs ?? []) as { coach_id: string; name: string | null; sports: string[]; price_usd: number; status: string }[]} isAdmin backHref="/admin" areas={ref.areas} sports={ref.sports} town={town} />;
}
