import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import MatchBoard, { type MatchRow } from "@/components/MatchBoard";

export default async function ClubMatches({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}/matches`);
  const { data: club } = await supabase.from("clubs").select("id, name, slug, timezone, open_time, close_time, slot_minutes").eq("slug", slug).single();
  if (!club) notFound();
  const [{ data: rows }, { data: myBookings }] = await Promise.all([
    supabase.rpc("match_board", { p_club: club.id, p_days: 14 }),
    supabase.from("bookings").select("id, start_at, end_at, courts!bookings_court_id_fkey(name)").eq("player_id", user.id).eq("club_id", club.id).eq("status", "confirmed").gt("start_at", new Date().toISOString()).order("start_at"),
  ]);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-24">
      <Link href={`/club/${slug}`} className="text-sm text-muted">‹ {club.name}</Link>
      <MatchBoard club={club} rows={(rows ?? []) as MatchRow[]} myBookings={(myBookings ?? []) as unknown as { id: string; start_at: string; end_at: string; courts: { name: string } | null }[]} />
    </main>
  );
}
