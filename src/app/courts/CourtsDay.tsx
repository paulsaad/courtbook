"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import type { Governorate, Sport } from "@/lib/geo";
import { EMPTY, readPrefs, writePrefs, type Prefs } from "@/lib/prefs";
import { shiftDate } from "@/lib/time";
import AreaPicker from "@/components/AreaPicker";
import { IconSearch } from "@/components/Icons";
import BookSheet, { type SheetClub } from "./BookSheet";

export type DaySlot = {
  club_id: string; club_name: string; slug: string; town: string | null; district: string | null; price_from: number | null; sports: string[];
  slot_minutes: number; min_minutes: number; max_minutes: number; service_fee_usd: number; hold_minutes: number; cancel_cutoff_hours: number; timezone: string;
  court_id: string; court_name: string; court_sport: string; start_at: string; free_minutes: number; is_demo: boolean | null;
};
type Resume = { at: string; court: string; dur: number | null } | null;
type Sheet = { club: SheetClub; at: string; courts: { id: string; name: string; free: number }[]; courtId: string; minutes: number | null };

const TZ = "Asia/Beirut";
const reqKey = (d: string, q: string, p: Prefs) => `${d}|${q}|${p.gov ?? ""}|${p.district ?? ""}|${p.sport ?? ""}`;

export default function CourtsDay({ areas, sports, today, date: initialDate, query: initialQuery, initial, initialError, signedIn, resume }: {
  areas: Governorate[]; sports: Sport[]; today: string; date: string; query: string; initial: DaySlot[]; initialError: boolean; signedIn: boolean; resume: Resume;
}) {
  // remembered sport/area are read synchronously on the client so the chips never flash back to the default
  const [prefs, setPrefs] = useState<Prefs>(() => (typeof window === "undefined" ? EMPTY : readPrefs()));
  const [loaded, setLoaded] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [query, setQuery] = useState(initialQuery);
  const [typed, setTyped] = useState(initialQuery);
  // results are tagged with the request they answer; anything else is "loading" and never tappable
  const [result, setResult] = useState<{ key: string; rows: DaySlot[] | null }>({ key: reqKey(initialDate, initialQuery, EMPTY), rows: initialError ? null : initial });
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const stripRef = useRef<HTMLDivElement>(null);
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;
  const days = Array.from({ length: 15 }, (_, i) => shiftDate(today, i));
  const dayOf = (d: string) => new Date(`${d}T12:00:00+02:00`);

  const key = reqKey(date, query, prefs);
  const rows: DaySlot[] | null | undefined = result.key === key ? result.rows : undefined;   // undefined = loading, null = failed
  const loading = rows === undefined;

  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => { stripRef.current?.querySelector<HTMLElement>("[data-on=true]")?.scrollIntoView({ inline: "center", block: "nearest" }); }, [date]);
  // keep the address bar honest without a navigation (refresh lands on the same day)
  useEffect(() => {
    if (!loaded) return;
    const u = new URL(window.location.href);
    u.searchParams.set("date", date); if (query) u.searchParams.set("q", query); else u.searchParams.delete("q");
    u.searchParams.delete("at"); u.searchParams.delete("court"); u.searchParams.delete("dur");
    window.history.replaceState(null, "", u.toString());
  }, [date, query, loaded]);

  // fetch whenever the request changes (or Retry); the answer is stored under its own key
  useEffect(() => {
    if (!loaded) return;
    if (result.key === key && retry === 0) return;
    let alive = true;
    (async () => {
      setBusy(true);
      const { data, error } = await createClient().rpc("club_day_slots", { p_date: date, p_sport: prefs.sport, p_governorate: prefs.gov, p_district: prefs.district, p_query: query.trim() || null });
      if (!alive) return;
      setBusy(false);
      setResult({ key, rows: error ? null : (data as DaySlot[]) });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded, retry]);
  // any change of day / area / sport / search closes an open booking panel
  useEffect(() => { const t = setTimeout(() => setSheet(null), 0); return () => clearTimeout(t); }, [key]);

  const update = (p: Prefs) => { setPrefs(p); writePrefs(p); };

  // group by club → distinct start times → courts free at that time
  const clubs = useMemo(() => {
    const m = new Map<string, { club: SheetClub; town: string | null; district: string | null; price_from: number | null; sports: string[]; is_demo: boolean; times: Map<string, { id: string; name: string; free: number }[]> }>();
    for (const r of rows ?? []) {
      let c = m.get(r.club_id);
      if (!c) {
        c = { club: { id: r.club_id, name: r.club_name, slug: r.slug, slot_minutes: r.slot_minutes, min_minutes: r.min_minutes, max_minutes: r.max_minutes, service_fee_usd: Number(r.service_fee_usd), hold_minutes: r.hold_minutes, cancel_cutoff_hours: r.cancel_cutoff_hours, timezone: r.timezone }, town: r.town, district: r.district, price_from: r.price_from, sports: r.sports, is_demo: r.is_demo ?? false, times: new Map() };
        m.set(r.club_id, c);
      }
      const list = c.times.get(r.start_at) ?? [];
      list.push({ id: r.court_id, name: r.court_name, free: r.free_minutes });
      c.times.set(r.start_at, list);
    }
    return [...m.values()];
  }, [rows]);
  const sportsPresent = useMemo(() => new Set((rows ?? []).flatMap((r) => r.sports)), [rows]);
  const chips = sports.filter((s) => sportsPresent.has(s.code) || s.code === prefs.sport || (prefs.sport === null && sportsPresent.size === 0));

  // coming back from sign-in: reopen the panel on the slot the player had chosen — once, when the first answer arrives
  const [resumed, setResumed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!resume || resumed || rows === undefined) return;
    const want = Date.parse(resume.at);
    const t = setTimeout(() => {
      setResumed(true);
      if (rows === null) { setNotice("Could not check that slot — pick a time below."); return; }
      const r = rows.find((x) => x.court_id === resume.court && Date.parse(x.start_at) === want);
      const c = clubs.find((x) => x.club.id === r?.club_id);
      if (r && c) setSheet({ club: c.club, at: r.start_at, courts: c.times.get(r.start_at) ?? [], courtId: r.court_id, minutes: resume.dur });
      else setNotice("That slot is no longer free — pick another time.");
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, resumed]);

  const chip = (on: boolean) => `chip ${on ? "chip-on" : ""}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col">
      <div className="flex items-center justify-between px-5 pt-12">
        <div className="text-[13px] font-bold uppercase tracking-wider text-muted">{formatInTimeZone(dayOf(date), TZ, "MMM yyyy")}</div>
        <AreaPicker areas={areas} value={{ gov: prefs.gov, district: prefs.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district })} />
      </div>
      <div ref={stripRef} className="flex gap-1 overflow-x-auto px-3 pb-3 pt-3">
        {days.map((d) => {
          const on = d === date;
          return (
            <button key={d} data-on={on} onClick={() => setDate(d)} className="flex w-[50px] shrink-0 flex-col items-center gap-1.5 text-xs font-semibold">
              <span className="text-[#8a918e]">{d === today ? "Today" : formatInTimeZone(dayOf(d), TZ, "EEEEE")}</span>
              <span className={`flex h-10 w-10 items-center justify-center rounded-full text-[17px] font-bold ${on ? "bg-cedar text-white" : ""}`}>{formatInTimeZone(dayOf(d), TZ, "d")}</span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-2 overflow-x-auto border-t border-grid px-5 py-3">
        <button onClick={() => update({ ...prefs, sport: null })} className={chip(!prefs.sport)}>All sports</button>
        {chips.map((s) => <button key={s.code} onClick={() => update({ ...prefs, sport: prefs.sport === s.code ? null : s.code })} className={chip(prefs.sport === s.code)}>{s.name_en}</button>)}
      </div>
      <div className="flex items-baseline justify-between px-5 pt-1">
        <div className="text-lg font-bold">{date === today ? "Today" : formatInTimeZone(dayOf(date), TZ, "EEEE, d MMMM")}</div>
        <div className="text-[13px] text-muted">{loading ? "loading…" : `${prefs.sport ? `${sportName(prefs.sport)} · ` : ""}${clubs.length} club${clubs.length === 1 ? "" : "s"}`}</div>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); setQuery(typed.trim()); }} className="mx-5 mt-2 flex items-center gap-2 rounded-full border border-grid bg-white px-4 py-2 text-sm">
        <IconSearch size={18} className="text-muted" />
        <input value={typed} onChange={(e) => setTyped(e.target.value)} enterKeyHint="search" placeholder="Club or town" className="flex-1 bg-transparent text-base outline-none" />
        {typed && <button type="button" onClick={() => { setTyped(""); setQuery(""); }} aria-label="Clear" className="px-1 text-muted">✕</button>}
      </form>
      {query && <div className="px-5 pt-2 text-[13px] text-muted">Showing clubs matching “{query}”</div>}
      {notice && <p className="mx-5 mt-3 flex items-center justify-between rounded-xl bg-sand-soft px-3 py-2 text-sm">{notice}<button onClick={() => setNotice(null)} aria-label="Dismiss" className="px-1 text-muted">✕</button></p>}

      <div className={`flex flex-col gap-3.5 px-5 pb-28 pt-3.5 ${busy || loading ? "opacity-60" : ""}`}>
        {rows === null && <p className="flex items-center justify-between rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">Could not load availability. <button onClick={() => setRetry((n) => n + 1)} className="font-semibold underline">Retry</button></p>}
        {loading && <p className="py-6 text-center text-sm text-muted">Loading availability…</p>}
        {rows && clubs.length === 0 && <p className="card p-6 text-center text-sm text-muted">No free courts for this day{prefs.sport ? ` in ${sportName(prefs.sport)}` : ""}. Try another day, sport or area.</p>}
        {clubs.map((c) => {
          const times = [...c.times.keys()].sort();
          const all = showAll[c.club.id];
          const shown = all ? times : times.slice(0, 6);
          return (
            <article key={c.club.id} className="card overflow-hidden">
              <Link href={`/club/${c.club.slug}?date=${date}`} className="flex items-center gap-3 p-4">
                <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{c.club.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[17px] font-bold leading-tight">{c.club.name}</div>
                  {/* Courts is its own list of clubs; the label has to reach it too, in words,
                      the same as Home and the club page. */}
                  {c.is_demo && (
                    <span className="mt-0.5 inline-block rounded-full bg-sand-soft px-2 py-0.5 text-[11px] font-semibold text-sand">Fictional demo club</span>
                  )}
                  <div className="text-sm text-muted">{[c.town, c.district].filter(Boolean).join(" · ") || "Lebanon"}{c.price_from != null ? ` · from $${Number(c.price_from).toFixed(0)}/h` : ""}{!prefs.sport && c.sports.length > 1 ? ` · ${c.sports.map(sportName).join(", ")}` : ""}</div>
                </div>
                <span className="text-muted">›</span>
              </Link>
              <div className="flex flex-wrap gap-2 border-t border-grid bg-[#fafaf8] px-4 py-3.5">
                {shown.map((at) => (
                  <button key={at} disabled={loading} onClick={() => setSheet({ club: c.club, at, courts: c.times.get(at)!, courtId: c.times.get(at)![0].id, minutes: null })} className="min-w-[72px] rounded-xl bg-turf-soft px-3 py-3 text-[15px] font-bold text-turf-deep disabled:opacity-50">{formatInTimeZone(new Date(at), c.club.timezone, "HH:mm")}</button>
                ))}
                {times.length > 6 && <button onClick={() => setShowAll({ ...showAll, [c.club.id]: !all })} className="self-center px-2 text-sm font-semibold text-turf">{all ? "Show fewer" : `${times.length - 6} more times`}</button>}
              </div>
            </article>
          );
        })}
      </div>

      {sheet && !loading && <BookSheet club={sheet.club} date={date} at={sheet.at} courts={sheet.courts} initialCourtId={sheet.courtId} initialMinutes={sheet.minutes} signedIn={signedIn} onClose={() => setSheet(null)} />}
    </main>
  );
}
