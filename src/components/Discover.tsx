"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import type { Governorate, Sport } from "@/lib/geo";
import { EMPTY, readPrefs, writePrefs, type Prefs } from "@/lib/prefs";
import AreaPicker from "./AreaPicker";

export type ClubCard = {
  club_id: string; name: string; slug: string; town: string | null; district: string | null; governorate: string | null;
  sports: string[]; price_from: number | null; next_free_at: string | null; next_free_court: string | null; next_free_court_id: string | null; location_url: string | null;
  open_time: string; close_time: string;
};
export type OpenMatch = {
  match_id: string; club_name: string; club_slug: string; town: string | null; sport: string; start_at: string; level: string | null;
  players_needed: number; joined: number; organizer_name: string | null; join_mode: string; i_joined: boolean;
};

const TZ = "Asia/Beirut";
const chip = (on: boolean) => `shrink-0 rounded-full border px-3.5 py-1.5 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;

export default function Discover({ areas, sports, initialClubs, initialMatches, signedIn, initialError }: { areas: Governorate[]; sports: Sport[]; initialClubs: ClubCard[]; initialMatches: OpenMatch[]; signedIn: boolean; initialError?: boolean }) {
  const [prefs, setPrefs] = useState<Prefs>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [clubs, setClubs] = useState(initialClubs);
  const [matches, setMatches] = useState(initialMatches);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(!!initialError);
  const [tick, setTick] = useState(0); // bumped by Retry
  // sport chips come from the area/search result *without* the sport filter, so other sports stay reachable
  const [facets, setFacets] = useState<string[]>([...new Set(initialClubs.flatMap((c) => c.sports))]);
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;

  // restore remembered filters after hydration (deferred so server and first client render match)
  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!loaded) return;
    const isDefault = !prefs.gov && !prefs.district && !prefs.sport && query.trim() === "";
    let alive = true;
    const t = setTimeout(async () => {
      if (isDefault && tick === 0 && !initialError) { setClubs(initialClubs); setMatches(initialMatches); setFacets([...new Set(initialClubs.flatMap((c) => c.sports))]); setBusy(false); setFailed(false); return; }
      setBusy(true);
      const supabase = createClient();
      const area = { p_governorate: prefs.gov, p_district: prefs.district };
      const q = query.trim() || null;
      const [c, f, m] = await Promise.all([
        supabase.rpc("club_discovery", { ...area, p_sport: prefs.sport, p_query: q }),
        prefs.sport ? supabase.rpc("club_discovery", { ...area, p_sport: null, p_query: q }) : Promise.resolve({ data: null, error: null }),
        signedIn ? supabase.rpc("open_matches", { ...area, p_sport: prefs.sport, p_limit: 3 }) : Promise.resolve({ data: [], error: null }),
      ]);
      if (!alive) return;
      setBusy(false);
      if (c.error || m.error || f.error) { setFailed(true); return; } // keep what was on screen
      setFailed(false);
      const list = (c.data ?? []) as ClubCard[];
      setClubs(list);
      setFacets([...new Set(((f.data ?? list) as ClubCard[]).flatMap((x) => x.sports))]);
      setMatches((m.data ?? []) as OpenMatch[]);
    }, query ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [prefs, query, loaded, initialClubs, initialMatches, signedIn, tick]);

  const update = (p: Prefs) => { setPrefs(p); writePrefs(p); };
  const chips = sports.filter((s) => facets.includes(s.code) || s.code === prefs.sport);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <AreaPicker areas={areas} value={{ gov: prefs.gov, district: prefs.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district })} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Club or town" className="w-[45%] rounded-full border border-grid bg-white px-3.5 py-2 text-sm outline-none focus:border-action" />
      </div>

      {chips.length > 0 && (
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5">
          <button onClick={() => update({ ...prefs, sport: null })} className={chip(!prefs.sport)}>All sports</button>
          {chips.map((s) => <button key={s.code} onClick={() => update({ ...prefs, sport: prefs.sport === s.code ? null : s.code })} className={chip(prefs.sport === s.code)}>{s.name_en}</button>)}
        </div>
      )}

      {failed && (
        <p className="flex items-center justify-between rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">Could not load clubs. <button onClick={() => setTick((n) => n + 1)} className="font-medium underline">Retry</button></p>
      )}
      <section className={`flex flex-col gap-3 ${busy ? "opacity-60" : ""}`}>
        {!failed && clubs.length === 0 && <p className="rounded-2xl border border-dashed border-grid p-6 text-center text-sm text-muted">No clubs here yet. Try a wider area or another sport.</p>}
        {clubs.map((c) => (
          <article key={c.club_id} className="overflow-hidden rounded-2xl border border-grid bg-white">
            <Link href={`/club/${c.slug}`} className="block p-4 active:bg-paper">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-medium leading-tight">{c.name}</h2>
                  <p className="text-sm text-muted">{[c.town, c.district].filter(Boolean).join(" · ") || "Lebanon"}</p>
                </div>
                {c.price_from != null && <span className="shrink-0 text-sm"><span className="text-muted">from </span><b>${Number(c.price_from).toFixed(0)}</b><span className="text-muted">/h</span></span>}
              </div>
              <p className="mt-2 text-sm">{c.sports.map(sportName).join(" · ")}</p>
            </Link>
            <div className="flex items-center justify-between border-t border-grid px-4 py-2.5 text-sm">
              {c.next_free_at ? (
                <Link href={`/club/${c.slug}?at=${encodeURIComponent(c.next_free_at)}&court=${c.next_free_court_id ?? ""}`} className="rounded-full bg-turf-soft px-3 py-1 font-medium text-turf">Today {formatInTimeZone(new Date(c.next_free_at), TZ, "HH:mm")} · {c.next_free_court} ›</Link>
              ) : (
                <span className="text-muted">Full today — see other days</span>
              )}
              <Link href={`/club/${c.slug}/coaches`} className="text-action">Coaches</Link>
            </div>
          </article>
        ))}
      </section>

      {signedIn && <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Open matches</h2>
          <Link href="/play" className="text-sm text-action">All ›</Link>
        </div>
        {matches.length === 0 && <p className="text-sm text-muted">No open matches in this area. <Link href="/play" className="text-action underline">Post one</Link></p>}
        {matches.map((m) => {
          const spots = m.players_needed - m.joined;
          return (
            <Link key={m.match_id} href={`/matches/${m.match_id}`} className="flex items-center gap-3 rounded-2xl border border-grid bg-white p-4 active:bg-paper">
              <div className="w-20 shrink-0 text-sm">
                <div className="font-medium">{formatInTimeZone(new Date(m.start_at), TZ, "EEE d MMM")}</div>
                <div className="text-muted">{formatInTimeZone(new Date(m.start_at), TZ, "HH:mm")}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{sportName(m.sport)}{m.level ? ` · ${m.level}` : ""} · {m.club_name}</div>
                <div className="truncate text-sm text-muted">{m.organizer_name ?? "player"}{m.town ? ` · ${m.town}` : ""}</div>
              </div>
              <span className="shrink-0 rounded-full bg-turf-soft px-2 py-0.5 text-xs text-turf">{m.i_joined ? "you're in" : `${spots} spot${spots === 1 ? "" : "s"}`}</span>
            </Link>
          );
        })}
      </section>}
    </div>
  );
}
