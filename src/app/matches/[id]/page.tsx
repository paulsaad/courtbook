import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { nowMs } from "@/lib/time";
import MatchActions from "./MatchActions";
import MatchChat from "./MatchChat";
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
  const member = m.i_organize || m.my_status === "accepted";
  const finished = new Date(m.start_at).getTime() < nowMs();
  const [{ data: people }, { data: msgs }, { data: hidden }] = await Promise.all([
    supabase.rpc("match_participants", { p_match: id }),
    member ? supabase.rpc("match_messages_list", { p_match: id, p_after: null }) : Promise.resolve({ data: [] }),
      supabase.rpc("match_is_hidden", { p_match: id }),
  ]);
  await supabase.rpc("mark_notifications_read", { p_ids: null }).then(() => {}, () => {});   // opening a match clears its notices (simple v0.1 rule)
  const participants = (people ?? []) as { profile_id: string; name: string | null; level: number | null; level_legacy: string | null; is_organizer: boolean; status: string }[];
  const accepted = participants.filter((p) => p.status === "accepted");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-24">
      <div className="flex justify-between text-sm"><Link href="/play" className="text-muted">‹ Find a game</Link><Link href={`/club/${m.club_slug}/matches`} className="text-action">{m.club_name} board ›</Link></div>
      <MatchCard m={m} tz={tz} />
      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-2 font-medium">Players {m.joined + 1}/{m.players_needed + 1}</h2>
        {accepted.length > 0 ? (
          <ul className="divide-y divide-grid text-sm">
            {accepted.map((p) => <li key={p.profile_id} className="flex justify-between py-2"><span>{p.name ?? "Player"}{p.is_organizer ? " · organizer" : ""}</span><span className="text-muted">{p.level != null ? `Level ${p.level}` : p.level_legacy ?? ""}</span></li>)}
          </ul>
        ) : (
          <p className="text-sm text-muted">{m.join_mode === "approval" ? "Ask to join; the organizer approves." : "Join to see who's playing."}</p>
        )}
      </section>
      <MatchActions m={m} participants={participants} />
      {member && m.status !== "cancelled" && <MatchChat matchId={id} meId={user.id} tz={tz} finished={finished} hidden={!!hidden} initial={(msgs ?? []) as { id: string; profile_id: string; name: string | null; body: string; created_at: string; deleted?: boolean }[]} />}
    </main>
  );
}
