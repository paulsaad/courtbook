import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";
import { todayIn } from "@/lib/time";

type Card = { coach_id: string; name: string | null; sports: string[]; levels: string[]; price_usd: number; bio: string | null; whatsapp: string | null; clubs: { id: string; name: string; slug: string; timezone: string }[] };
type Win = { day: string; start_time: string; end_time: string; source: string };

export default async function CoachPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ club?: string }> }) {
  const { id } = await params;
  const { club: qClub } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/coaches/${id}`);
  const { data } = await supabase.rpc("coach_card", { p_coach: id });
  const card = ((data ?? []) as Card[])[0];
  if (!card) notFound();
  const club = card.clubs.find((c) => c.slug === qClub) ?? card.clubs[0];
  const from = club ? todayIn(club.timezone) : new Date().toISOString().slice(0, 10);
  const { data: win } = club ? await supabase.rpc("coach_availability", { p_coach: id, p_club: club.id, p_from: from, p_days: 7 }) : { data: [] };
  const windows = (win ?? []) as Win[];
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const { data: me } = await supabase.from("profiles").select("name").eq("id", user.id).single();
  const waNumber = card.whatsapp?.replace(/[^\d]/g, "");
  const waText = encodeURIComponent(`Hi ${card.name ?? ""}, I found you on CourtBook${club ? ` (${club.name})` : ""}. I'd like to book a session. — ${me?.name ?? ""}`);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-28">
      <Link href={club ? `/club/${club.slug}/coaches` : "/"} className="text-sm text-muted">‹ Coaches</Link>
      <div>
        <div className="flex items-baseline justify-between"><h1 className="text-2xl font-semibold tracking-tight">{card.name ?? "Coach"}</h1><span className="text-lg font-semibold">${Number(card.price_usd).toFixed(0)}/h</span></div>
        <p className="text-sm text-muted">{card.sports.join(", ")}{card.levels.length ? ` · ${card.levels.join(", ")}` : ""}</p>
        {card.bio && <p className="mt-2">{card.bio}</p>}
        {card.clubs.length > 1 && (
          <div className="mt-3 flex gap-2">{card.clubs.map((c) => <Link key={c.id} href={`/coaches/${id}?club=${c.slug}`} className={`rounded-full border px-3 py-1 text-sm ${c.id === club?.id ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{c.name}</Link>)}</div>
        )}
      </div>

      {club && (
        <section className="rounded-2xl border border-grid bg-white p-4">
          <h2 className="mb-2 font-medium">Next 7 days at {club.name}</h2>
          <ul className="divide-y divide-grid text-sm">
            {days.map((d) => {
              const w = windows.filter((x) => x.day === d);
              return (
                <li key={d} className="flex items-start justify-between gap-3 py-2">
                  <span className="w-20 shrink-0 text-muted">{formatInTimeZone(new Date(`${d}T12:00:00Z`), "UTC", "EEE d MMM")}</span>
                  <span className="flex flex-1 flex-wrap justify-end gap-1">
                    {w.length === 0 ? <span className="text-muted/60">—</span> : w.map((x, i) => <span key={i} className="rounded-md bg-turf-soft px-2 py-0.5 text-turf">{x.start_time.slice(0, 5)}–{x.end_time.slice(0, 5)}</span>)}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Times the coach says they are free. Agree the exact session with them; court booking is separate.</p>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md p-4">
        {waNumber ? (
          <a href={`https://wa.me/${waNumber}?text=${waText}`} target="_blank" rel="noreferrer" className="block rounded-xl bg-[#25D366] py-3.5 text-center font-medium text-white shadow-lg">Message on WhatsApp</a>
        ) : (
          <p className="rounded-xl border border-grid bg-white p-3 text-center text-sm text-muted">This coach has not shared a contact number yet.</p>
        )}
      </div>
    </main>
  );
}
