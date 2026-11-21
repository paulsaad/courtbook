import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import type { ClubMedia } from "@/lib/media";
import ClubSettings from "@/components/ClubSettings";
import { loadRefDataChecked as loadRefData, loadTownChecked as loadTown } from "@/lib/refData";
import WorkNav from "@/components/WorkNav";

export default async function StaffSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: club } = loaded(await supabase.from("clubs").select("*").eq("slug", slug).single(), "this club's settings");
  if (!club) notFound();
  const { data: me } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "this club's settings");
  const isAdmin = me?.roles?.includes("admin") ?? false;
  const { count } = loaded(await supabase.from("club_staff").select("*", { count: "exact", head: true }).eq("club_id", club.id).eq("profile_id", user.id), "this club's settings");
  if (!isAdmin && !count) return <main className="p-6">You are not staff at {club.name}.</main>;

  const [{ data: courts }, { data: rules }, { data: staff }, { data: coachReqs }, ref, town] = allLoaded(await Promise.all([
    supabase.from("courts").select("*").eq("club_id", club.id).order("sort"),
    supabase.from("price_rules").select("*").eq("club_id", club.id).order("start_time"),
    supabase.rpc("club_staff_list", { p_club: club.id }),
    supabase.rpc("club_coach_requests", { p_club: club.id }),
    loadRefData(supabase),
    loadTown(supabase, club.town_id ?? null),
  ]), "this club's settings");
  const { data: media } = loaded(await supabase.from("club_media")
    .select("id, kind, path, external_url, caption, sort, width, height").eq("club_id", club.id).order("sort"), "this club's settings");

  return <><WorkNav area="staff" slug={slug} clubName={club.name} active="settings" /><ClubSettings club={club} courts={courts ?? []} rules={rules ?? []} staff={(staff ?? []) as { profile_id: string; name: string | null; email: string }[]} coaches={(coachReqs ?? []) as { coach_id: string; name: string | null; sports: string[]; price_usd: number; status: string }[]} isAdmin={isAdmin} backHref={`/staff/${slug}`} areas={ref.areas} sports={ref.sports} town={town} media={(media ?? []) as ClubMedia[]} /></>;
}
