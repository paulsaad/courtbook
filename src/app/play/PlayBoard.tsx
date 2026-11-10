"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import type { Governorate, Sport } from "@/lib/geo";
import { EMPTY, readPrefs, writePrefs, type Prefs } from "@/lib/prefs";
import AreaPicker from "@/components/AreaPicker";
import type { OpenMatch } from "@/components/Discover";

const TZ = "Asia/Beirut";
const LEVELS = ["beginner", "intermediate", "advanced"];
const chip = (on: boolean) => `shrink-0 rounded-full border px-3.5 py-1.5 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;

export default function PlayBoard({ areas, sports, initial, clubs }: { areas: Governorate[]; sports: Sport[]; initial: OpenMatch[]; clubs: { id: string; name: string; slug: string }[] }) {
  const [prefs, setPrefs] = useState<Prefs>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [when, setWhen] = useState<"today" | "week" | "any">("any");
  const [rows, setRows] = useState(initial);
  const [busy, setBusy] = useState(false);
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;

  // restore remembered filters after hydration (deferred so server and first client render match)
  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    (async () => {
      setBusy(true);
      const now = new Date();
      const to = when === "today" ? new Date(now.getTime() + 24 * 3600e3) : when === "week" ? new Date(now.getTime() + 7 * 24 * 3600e3) : null;
      const { data } = await createClient().rpc("open_matches", { p_sport: prefs.sport, p_level: level, p_to: to?.toISOString() ?? null, p_governorate: prefs.gov, p_district: prefs.district, p_limit: 50 });
      if (alive) { setRows((data ?? []) as OpenMatch[]); setBusy(false); }
    })();
    return () => { alive = false; };
  }, [prefs, level, when, loaded]);
  const update = (p: Prefs) => { setPrefs(p); writePrefs(p); };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Find a game</h1>
        <AreaPicker areas={areas} value={{ gov: prefs.gov, district: prefs.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district })} />
      </header>
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5">
        <button onClick={() => update({ ...prefs, sport: null })} className={chip(!prefs.sport)}>All sports</button>
        {sports.filter((s) => s.code !== "other").map((s) => <button key={s.code} onClick={() => update({ ...prefs, sport: prefs.sport === s.code ? null : s.code })} className={chip(prefs.sport === s.code)}>{s.name_en}</button>)}
      </div>
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5">
        {(["today", "week", "any"] as const).map((w) => <button key={w} onClick={() => setWhen(w)} className={chip(when === w)}>{w === "today" ? "Today" : w === "week" ? "This week" : "Any day"}</button>)}
        <span className="w-px shrink-0 bg-grid" />
        {LEVELS.map((l) => <button key={l} onClick={() => setLevel(level === l ? null : l)} className={chip(level === l)}>{l}</button>)}
      </div>

      <section className={`flex flex-col gap-3 ${busy ? "opacity-60" : ""}`}>
        {rows.length === 0 && <p className="rounded-2xl border border-dashed border-grid p-6 text-center text-sm text-muted">No open matches match these filters.</p>}
        {rows.map((m) => {
          const spots = m.players_needed - m.joined;
          return (
            <Link key={m.match_id} href={`/matches/${m.match_id}`} className="block rounded-2xl border border-grid bg-white p-4 active:bg-paper">
              <div className="flex items-baseline justify-between">
                <span className="font-medium">{formatInTimeZone(new Date(m.start_at), TZ, "EEE d MMM · HH:mm")}</span>
                <span className="rounded-full bg-turf-soft px-2 py-0.5 text-xs text-turf">{m.i_joined ? "you're in" : `${spots} spot${spots === 1 ? "" : "s"} left`}</span>
              </div>
              <div className="mt-1 text-sm">{sportName(m.sport)}{m.level ? ` · ${m.level}` : ""} · {m.club_name}{m.town ? ` · ${m.town}` : ""}</div>
              <div className="text-sm text-muted">by {m.organizer_name ?? "player"}{m.join_mode === "approval" ? " · organizer approves" : ""}</div>
            </Link>
          );
        })}
      </section>

      <section className="rounded-2xl border border-grid bg-white p-4">
        <h2 className="font-medium">Post a match</h2>
        <p className="mt-1 text-sm text-muted">Pick the club you&apos;ll play at:</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {clubs.map((c) => <li key={c.id}><Link href={`/club/${c.slug}/matches`} className="rounded-full border border-grid px-3 py-1.5 text-sm">{c.name}</Link></li>)}
        </ul>
      </section>
    </main>
  );
}
