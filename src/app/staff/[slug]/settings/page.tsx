import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ClubSettings from "@/components/ClubSettings";
import { loadRefData, loadTown } from "@/lib/geo";

export default async function StaffSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: club } = await supabase.from("clubs").select("*").eq("slug", slug).single();
  if (!club) notFound();
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  const isAdmin = me?.roles?.includes("admin") ?? false;
  const { count } = await supabase.from("club_staff").select("*", { count: "exact", head: true }).eq("club_id", club.id).eq("profile_id", user.id);
  if (!isAdmin && !count) return <main className="p-6">You are not staff at {club.name}.</main>;

  const [{ data: courts }, { data: rules }, { data: staff }, { data: coachReqs }, ref, town] = await Promise.all([
    supabase.from("courts").select("*").eq("club_id", club.id).order("sort"),
    supabase.from("price_rules").select("*").eq("club_id", club.id).order("start_time"),
    supabase.rpc("club_staff_list", { p_club: club.id }),
    supabase.rpc("club_coach_requests", { p_club: club.id }),
    loadRefData(supabase),
    loadTown(supabase, club.town_id ?? null),
  ]);
  return <ClubSettings club={club} courts={courts ?? []} rules={rules ?? []} staff={(staff ?? []) as { profile_id: string; name: string | null; email: string }[]} coaches={(coachReqs ?? []) as { coach_id: string; name: string | null; sports: string[]; price_usd: number; status: string }[]} isAdmin={isAdmin} backHref={`/staff/${slug}`} areas={ref.areas} sports={ref.sports} town={town} />;
}
