import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { GROUP_LABEL, GROUP_RANGE, GUIDE, HOW_TO_CHOOSE, INTRO, levelGroup } from "@/lib/levels";

/** "Find your playing level" — the article and the per-sport tables. Public. */
export default async function LevelsGuide() {
  const supabase = await createClient();
  const { data: sportRows } = await supabase.from("sports").select("code, name_en").eq("active", true).order("sort_order");
  const names = new Map(((sportRows ?? []) as { code: string; name_en: string }[]).map((s) => [s.code, s.name_en]));
  const sports = ((sportRows ?? []) as { code: string }[]).map((s) => s.code).filter((c) => GUIDE[c]);
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pt-12">
      <Link href="/profile" className="text-sm text-muted">‹ Profile</Link>
      <h1 className="text-[28px] font-extrabold tracking-tight">Find your playing level</h1>
      <p className="text-[15px] leading-relaxed">{INTRO}</p>
      <section className="card p-4">
        <h2 className="font-bold">How to choose</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{HOW_TO_CHOOSE.map((t) => <li key={t}>{t}</li>)}</ol>
        <p className="mt-3 text-sm text-muted">If you have never played, start at Level 1. If you are unsure, choose “Not sure yet” and set it later. Levels are self-assessed and separate for every sport.</p>
      </section>
      <section className="card overflow-hidden">
        <div className="eyebrow px-4 pb-1.5 pt-3.5">What the groups mean</div>
        {(["beginner", "intermediate", "advanced"] as const).map((g) => (
          <div key={g} className="flex gap-3 border-t border-grid px-4 py-3 text-sm"><b className="w-28 shrink-0">{GROUP_LABEL[g]} {GROUP_RANGE[g][0]}–{GROUP_RANGE[g][1]}</b><span className="text-ink/80">{g === "beginner" ? "You are building the basics and becoming comfortable joining games." : g === "intermediate" ? "You can contribute reliably and are learning to handle pressure and make better choices." : "You can execute skills and adapt your decisions as the speed and difficulty increase."}</span></div>
        ))}
      </section>
      <nav className="-mx-5 flex gap-2 overflow-x-auto px-5">{sports.map((c) => <a key={c} href={`#${c}`} className="chip">{names.get(c) ?? c}</a>)}</nav>
      {sports.map((c) => (
        <section key={c} id={c} className="flex flex-col gap-2 scroll-mt-4">
          <h2 className="text-xl font-bold">{names.get(c) ?? c}</h2>
          <p className="text-sm text-muted">{GUIDE[c].intro}</p>
          <ol className="card divide-y divide-grid overflow-hidden">
            {GUIDE[c].levels.map(({ level, text }) => (
              <li key={level} className="flex gap-3 px-4 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf">{level}</span>
                <span className="min-w-0 text-sm"><span className="block text-xs font-bold text-muted">{GROUP_LABEL[levelGroup(level)!]}</span>{text}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p className="text-xs text-muted">These are self-selected app levels, drafted for CourtBook; they will be refined with coach and player feedback. An official competition rating uses its own scale.</p>
    </main>
  );
}
