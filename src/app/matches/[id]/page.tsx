import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { playerGatePath } from "@/lib/playerGate";
import { createClient } from "@/lib/supabase/server";
import { allLoaded, loaded } from "@/lib/load";
import { isMalformedId } from "@/lib/ids";
import { nowMs } from "@/lib/time";
import MatchActions from "./MatchActions";
import MatchChat from "./MatchChat";
import { MatchCard, type MatchRow } from "@/components/MatchBoard";

export default async function MatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/matches/${id}`);
  const gate = await playerGatePath(supabase, user.id, `/matches/${id}`, "this game");
  if (gate) redirect(gate);
  const found = await loadMatch(supabase, id);
  if (!found) notFound();
  const m = found.m;
  const tz: string = found.tz
    ?? loaded(await supabase.from("clubs").select("timezone").eq("id", m.club_id).single(), "this game").data?.timezone
    ?? "Asia/Beirut";
  const member = m.i_organize || m.my_status === "accepted";
  // finished means the match has ended, not merely started (same rule as hide_match)
  const endsAt = m.end_at ? new Date(m.end_at).getTime() : new Date(m.start_at).getTime() + 3 * 60 * 60 * 1000;
  const finished = endsAt < nowMs();
  const [{ data: people }, { data: msgs }, { data: hidden }] = allLoaded(await Promise.all([
    supabase.rpc("match_participants", { p_match: id }),
    member ? supabase.rpc("match_messages_list", { p_match: id, p_after: null }) : Promise.resolve({ data: [] }),
      supabase.rpc("match_is_hidden", { p_match: id }),
  ]), "this game");
  await supabase.rpc("mark_notifications_read", { p_ids: null }).then(() => {}, () => {});   // opening a match clears its notices (simple v0.1 rule)
  const participants = (people ?? []) as { profile_id: string; name: string | null; level: number | null; level_legacy: string | null; is_organizer: boolean; status: string }[];
  const accepted = participants.filter((p) => p.status === "accepted");

  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5 pb-24">
      <div className="flex justify-between text-sm"><Link href="/play" className="text-muted">‹ Find a game</Link><Link href={`/club/${m.club_slug}/matches`} className="text-action">{m.club_name} board ›</Link></div>
      <MatchCard m={m} tz={tz} />
      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="mb-2 font-medium">Players {m.joined + 1}/{m.players_needed + 1}</h2>
        {accepted.length > 0 ? (
          <ul className="divide-y divide-grid text-sm">
            {accepted.map((p) => <li key={p.profile_id} className="flex justify-between py-2"><span>{p.name ?? "Player"}{p.is_organizer ? " · organizer" : ""}</span><span className="text-muted">
              {p.level != null ? `Level ${p.level}`
                : p.profile_id === user.id
                  ? <Link href="/profile" className="text-action underline">Level not set — set yours</Link>
                  : "Level not set"}
            </span></li>)}
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

type Supa = Awaited<ReturnType<typeof createClient>>;
type DetailRow = Omit<MatchRow, "pending" | "organizer_id"> & { pending: number | null; organizer_id: string | null; club_timezone: string | null };

// One game, whatever its state: match_detail (migration 0067) shows a game to its organiser and
// players after it starts too, where match_board (future games only) made this page 404. Until 0067
// is on the database the function does not exist (PostgREST PGRST202) and the page falls back to
// the board, exactly as before.
async function loadMatch(supabase: Supa, id: string): Promise<{ m: MatchRow; tz: string | null } | null> {
  const detail = await supabase.rpc("match_detail", { p_match: id });
  if (isMalformedId(detail.error)) return null;   // a malformed id names no game: Not found (as #78)
  if (!detail.error) {
    const d = ((detail.data ?? []) as DetailRow[])[0];
    if (!d) return null;
    return { m: { ...d, pending: d.pending ?? 0, organizer_id: d.organizer_id ?? "" }, tz: d.club_timezone };
  }
  if (detail.error.code !== "PGRST202") loaded(detail, "this game");   // throws: a failed read, not "no game"
  const { data: rows } = loaded(await supabase.rpc("match_board", { p_club: null, p_days: 60 }), "this game");
  const m = ((rows ?? []) as MatchRow[]).find((x) => x.match_id === id);
  return m ? { m, tz: null } : null;
}
