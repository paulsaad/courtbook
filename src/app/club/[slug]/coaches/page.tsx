import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type CoachRow = { coach_id: string; name: string | null; sports: string[]; levels: string[]; price_usd: number; bio: string | null; whatsapp: string | null };

export default async function ClubCoaches({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/club/${slug}/coaches`);
  const { data: club } = await supabase.from("clubs").select("id, name, slug").eq("slug", slug).single();
  if (!club) notFound();
  const { data } = await supabase.rpc("coaches_at_club", { p_club: club.id });
  const coaches = (data ?? []) as CoachRow[];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <Link href={`/club/${slug}`} className="text-sm text-muted">‹ {club.name}</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Coaches at {club.name}</h1>
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
    </main>
  );
}
