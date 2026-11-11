import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Row = { coach_id: string; name: string | null; sports: string[]; levels: string[]; price_usd: number; whatsapp: string | null; club_id: string; club_name: string; club_slug: string; town: string | null };

/** Coaches across all clubs (signed-in). Contact goes through the coach page as before. */
export default async function CoachesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/coaches");
  const [{ data }, { data: sportRows }] = await Promise.all([supabase.rpc("coaches_directory"), supabase.from("sports").select("code, name_en")]);
  const names = new Map(((sportRows ?? []) as { code: string; name_en: string }[]).map((s) => [s.code, s.name_en]));
  const rows = (data ?? []) as Row[];
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5 pt-12">
      <Link href="/" className="text-sm text-muted">‹ Home</Link>
      <h1 className="text-[26px] font-extrabold tracking-tight">Coaches</h1>
      {rows.length === 0 && <p className="card p-6 text-center text-sm text-muted">No coaches listed yet. Are you a coach? <Link href="/coach" className="font-semibold text-turf">Set up your profile</Link></p>}
      <ul className="flex flex-col gap-3">
        {rows.map((c) => (
          <li key={c.coach_id + c.club_id}>
            <Link href={`/coaches/${c.coach_id}?club=${c.club_slug}`} className="card flex items-center gap-3 p-4">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sand-soft text-sm font-extrabold text-sand" aria-hidden="true">{(c.name ?? "C").slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-bold">{c.name ?? "Coach"}</div>
                <div className="truncate text-sm text-muted">{c.sports.map((s) => names.get(s) ?? s).join(", ")} · {c.club_name}{c.town ? ` · ${c.town}` : ""}</div>
              </div>
              <span className="font-bold">${Number(c.price_usd).toFixed(0)}<span className="text-sm font-normal text-muted">/h</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
