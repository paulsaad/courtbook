import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import MatchActions from "./MatchActions";
import { MatchCard, type MatchRow } from "@/components/MatchBoard";

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/matches/${id}`);
  const { data: rows } = await supabase.rpc("match_board", { p_club: null, p_days: 60 });
  const m = ((rows ?? []) as MatchRow[]).find((x) => x.match_id === id);
  if (!m) notFound();
  const { data: tzRow } = await supabase.from("clubs").select("timezone").eq("id", m.club_id).single();
  const tz = tzRow?.timezone ?? "Asia/Beirut";
  const { data: people } = await supabase.rpc("match_participants", { p_match: id });
  const participants = (people ?? []) as { profile_id: string; name: string | null; level: string | null; is_organizer: boolean }[];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-24">
      <Link href={`/club/${m.club_slug}/matches`} className="text-sm text-muted">‹ {m.club_name} matches</Link>
      <MatchCard m={m} tz={tz} />
      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-2 font-medium">Players {m.joined + 1}/{m.players_needed + 1}</h2>
        {participants.length > 0 ? (
          <ul className="divide-y divide-grid text-sm">
            {participants.map((p) => <li key={p.profile_id} className="flex justify-between py-2"><span>{p.name ?? "Player"}{p.is_organizer ? " · organizer" : ""}</span><span className="text-muted">{p.level ?? ""}</span></li>)}
          </ul>
        ) : (
          <p className="text-sm text-muted">Join to see who's playing.</p>
        )}
      </section>
      <MatchActions m={m} />
    </main>
  );
}
