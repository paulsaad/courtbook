import { notFound, redirect } from "next/navigation";
import { playerGatePath } from "@/lib/playerGate";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import MatchBoard, { type MatchRow } from "@/components/MatchBoard";
import { loadClubHead } from "@/lib/clubHead";
import ClubHeader from "../ClubHeader";

export default async function ClubMatches({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}/matches`);
  const gate = await playerGatePath(supabase, user.id, `/club/${slug}/matches`, "this club");
  if (gate) redirect(gate);
  const { data: club } = loaded(await supabase.from("clubs").select("id, name, slug, timezone, open_time, close_time, slot_minutes, location_url, town_id, is_demo, lat, lng").eq("slug", slug).single(), "this club");
  if (!club) notFound();
  const [{ data: rows }, { data: myBookings }, head, { data: clubSports }, { data: sportRows }] = allLoaded(await Promise.all([
    supabase.rpc("match_board", { p_club: club.id, p_days: 14 }),
    supabase.from("bookings").select("id, start_at, end_at, courts!bookings_court_id_fkey(name)").eq("player_id", user.id).eq("club_id", club.id).eq("status", "confirmed").gt("start_at", new Date().toISOString()).order("start_at"),
    loadClubHead(supabase, club),
    supabase.rpc("club_sports", { p_club: club.id }),
    supabase.from("sports").select("code, name_en").order("sort_order"),
  ]), "this club's games");
  const sportsHere = ((sportRows ?? []) as { code: string; name_en: string }[]).filter((s) => ((clubSports ?? []) as string[]).includes(s.code));
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <ClubHeader club={head} tab="/matches" signedIn={!!user} />
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 p-5 pb-24">
      <MatchBoard club={club} rows={(rows ?? []) as MatchRow[]} sports={sportsHere} myBookings={(myBookings ?? []) as unknown as { id: string; start_at: string; end_at: string; courts: { name: string } | null }[]} />
      </div>
    </main>
  );
}
