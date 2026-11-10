import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadClubHead } from "@/lib/clubHead";
import ClubHeader from "../ClubHeader";

type CoachRow = { coach_id: string; name: string | null; sports: string[]; levels: string[]; price_usd: number; bio: string | null; whatsapp: string | null };

export default async function ClubCoaches({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}/coaches`);
  const { data: club } = await supabase.from("clubs").select("id, name, slug, open_time, close_time, location_url, town_id").eq("slug", slug).single();
  if (!club) notFound();
  const [{ data }, head] = await Promise.all([supabase.rpc("coaches_at_club", { p_club: club.id }), loadClubHead(supabase, club)]);
  const coaches = (data ?? []) as CoachRow[];

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <ClubHeader club={head} tab="/coaches" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-5 p-5">
      {coaches.length === 0 && <p className="text-muted">No coaches listed here yet.</p>}
      <ul className="flex flex-col gap-3">
        {coaches.map((c) => (
          <li key={c.coach_id}>
            <Link href={`/coaches/${c.coach_id}?club=${club.slug}`} className="block rounded-2xl border border-grid bg-white p-4 active:bg-paper">
              <div className="flex items-baseline justify-between"><span className="text-lg font-medium">{c.name ?? "Coach"}</span><span className="font-semibold">${Number(c.price_usd).toFixed(0)}/h</span></div>
              <div className="mt-1 text-sm text-muted">{c.sports.join(", ")}{c.levels.length ? ` · ${c.levels.join(", ")}` : ""}</div>
              {c.bio && <p className="mt-2 line-clamp-2 text-sm">{c.bio}</p>}
            </Link>
          </li>
        ))}
      </ul>
      </div>
    </main>
  );
}
