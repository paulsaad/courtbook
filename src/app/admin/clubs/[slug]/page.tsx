import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import type { ClubMedia } from "@/lib/media";
import ClubSettings from "@/components/ClubSettings";
import type { ReadinessRow } from "@/components/ClubReadiness";
import { isMissingFunction } from "@/lib/missingFunction";
import { loadRefDataChecked as loadRefData, loadTownChecked as loadTown } from "@/lib/refData";
import WorkNav from "@/components/WorkNav";

export default async function AdminClubPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "this club");
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const { data: club } = loaded(await supabase.from("clubs").select("*").eq("slug", slug).single(), "this club");
  if (!club) notFound();
  const [{ data: courts }, { data: rules }, { data: staff }, { data: coachReqs }, ref, town] = allLoaded(await Promise.all([
    supabase.from("courts").select("*").eq("club_id", club.id).order("sort"),
    supabase.from("price_rules").select("*").eq("club_id", club.id).order("start_time"),
    supabase.rpc("club_staff_list", { p_club: club.id }),
    supabase.rpc("club_coach_requests", { p_club: club.id }),
    loadRefData(supabase),
    loadTown(supabase, club.town_id ?? null),
  ]), "this club");
  // M8 (0081): the readiness checklist; before 0081 the function is missing and no checklist is shown
  const readinessRes = await supabase.rpc("club_readiness", { p_club: club.id });
  const readiness = readinessRes.error && isMissingFunction(readinessRes.error) ? null : ((loaded(readinessRes, "this club").data ?? []) as ReadinessRow[]);
  const { data: media } = loaded(await supabase.from("club_media")
    .select("id, kind, path, external_url, caption, sort, width, height").eq("club_id", club.id).order("sort"), "this club");

  return <><WorkNav area="admin" active="clubs" /><ClubSettings club={club} courts={courts ?? []} rules={rules ?? []} staff={(staff ?? []) as { profile_id: string; name: string | null; email: string }[]} coaches={(coachReqs ?? []) as { coach_id: string; name: string | null; sports: string[]; price_usd: number; status: string }[]} isAdmin backHref="/admin" areas={ref.areas} sports={ref.sports} town={town} media={(media ?? []) as ClubMedia[]} readiness={readiness} /></>;
}
