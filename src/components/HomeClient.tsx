"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import type { Governorate, Sport } from "@/lib/geo";
import { EMPTY, readPrefs, writePrefs, type Prefs } from "@/lib/prefs";
import AreaPicker from "./AreaPicker";
import { IconCourt, IconPin, IconRacket, IconSearch, IconUsers } from "./Icons";
import type { OpenMatch } from "./Discover";

const TZ = "Asia/Beirut";

/** Home: area row, search, three actions, matches for you. The next-game card is rendered by the server page above this. */
export default function HomeClient({ areas, sports, initialMatches, signedIn }: { areas: Governorate[]; sports: Sport[]; initialMatches: OpenMatch[]; signedIn: boolean }) {
  const [prefs, setPrefs] = useState<Prefs>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [matches, setMatches] = useState(initialMatches);
  const [q, setQ] = useState("");
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;

  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (!loaded || !signedIn) return;
    let alive = true;
    if (!prefs.gov && !prefs.district) { Promise.resolve().then(() => { if (alive) setMatches(initialMatches); }); return () => { alive = false; }; }
    createClient().rpc("open_matches", { p_governorate: prefs.gov, p_district: prefs.district, p_limit: 6 }).then(({ data }) => { if (alive && data) setMatches(data as OpenMatch[]); });
    return () => { alive = false; };
  }, [prefs, loaded, signedIn, initialMatches]);
  const update = (p: Prefs) => { setPrefs(p); writePrefs(p); };

  const action = "flex flex-col items-center gap-2.5 text-sm font-bold text-ink";
  const circle = "flex h-[84px] w-[84px] items-center justify-center rounded-full";

  return (
    <div className="flex flex-col gap-4">
      <AreaPicker areas={areas} value={{ gov: prefs.gov, district: prefs.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district })}
        trigger={(open, label) => (
          <button onClick={open} className="card flex w-full items-center justify-between px-4 py-3 text-left">
            <span className="flex items-center gap-3"><IconPin size={22} className="text-cedar" /><span><span className="eyebrow block">Playing in</span><span className="text-base font-bold">{label}</span></span></span>
            <span className="text-sm font-semibold text-turf">Change</span>
          </button>
        )} />

      <form onSubmit={(e) => { e.preventDefault(); window.location.href = `/courts?q=${encodeURIComponent(q.trim())}`; }} className="flex items-center gap-2.5 rounded-full border border-grid bg-white px-4 py-3">
        <IconSearch size={20} className="text-muted" />
        <input name="q" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clubs or towns" className="flex-1 bg-transparent text-base outline-none" />
      </form>

      <div className="grid grid-cols-3 gap-3 py-1">
        <Link href="/courts" className={action}><span className={`${circle} bg-turf-soft`}><IconCourt size={34} className="text-turf" /></span>Book a court</Link>
        <Link href="/play" className={action}><span className={`${circle} bg-cedar-soft`}><IconUsers size={34} className="text-cedar" /></span>Find a game</Link>
        <Link href="/coaches" className={action}><span className={`${circle} bg-sand-soft`}><IconRacket size={34} className="text-sand" /></span>Coaches</Link>
      </div>

      {signedIn && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between"><h2 className="text-xl font-bold">Matches for you</h2><Link href="/play" className="text-sm font-semibold text-turf">See all</Link></div>
          {matches.length === 0 ? (
            <p className="card p-5 text-center text-sm text-muted">No open matches in this area yet. <Link href="/play" className="font-semibold text-turf">Post one</Link></p>
          ) : (
            <div className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-1">
              {matches.slice(0, 6).map((m) => {
                const spots = Math.max(0, m.players_needed - m.joined);
                return (
                  <Link key={m.match_id} href={`/matches/${m.match_id}`} className={`card flex min-w-[230px] flex-col gap-3 p-3.5 ${spots > 0 && !m.i_joined ? "border-[#f3d4d9] bg-[#fff8f9]" : ""}`}>
                    <div><div className="text-[15px] font-bold">{sportName(m.sport)}{m.level ? ` · ${m.level}` : " · any level"}</div><div className="text-[13px] text-muted">{m.club_name}{m.town ? ` · ${m.town}` : ""}</div></div>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: Math.min(m.joined + 1, 4) }, (_, i) => <span key={i} className="inline-flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-turf text-xs font-bold text-white shadow-[0_0_0_1px_#e6e8e5]" aria-hidden="true">{i === 0 ? (m.organizer_name ?? "P").slice(0, 1).toUpperCase() : "·"}</span>)}
                      {Array.from({ length: Math.min(spots, 3) }, (_, i) => <span key={`s${i}`} className="inline-flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-cedar font-bold text-cedar" aria-hidden="true">+</span>)}
                    </div>
                    <div className="text-sm font-semibold">{formatInTimeZone(new Date(m.start_at), TZ, "EEE d MMM · HH:mm")} {m.i_joined ? <span className="text-turf">· you&apos;re in</span> : <span className="text-cedar">· {spots} spot{spots === 1 ? "" : "s"}</span>}</div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
