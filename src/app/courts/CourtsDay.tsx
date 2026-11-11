"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
  court_id: string; court_name: string; court_sport: string; start_at: string; free_minutes: number;
};
type Resume = { at: string; court: string; dur: number | null } | null;

export default function CourtsDay({ areas, sports, today, date, query, initial, initialError, signedIn, resume }: {
  areas: Governorate[]; sports: Sport[]; today: string; date: string; query: string; initial: DaySlot[]; initialError: boolean; signedIn: boolean; resume: Resume;
}) {
  const router = useRouter();
  const [prefs, setPrefs] = useState<Prefs>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<DaySlot[] | null>(initialError ? null : initial);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [sheet, setSheet] = useState<{ club: SheetClub; at: string; courts: { id: string; name: string; free: number }[]; courtId: string; minutes: number | null } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;
  const days = Array.from({ length: 15 }, (_, i) => shiftDate(today, i));
  const dayOf = (d: string) => new Date(`${d}T12:00:00+02:00`);

  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  useEffect(() => { stripRef.current?.querySelector<HTMLElement>("[data-on=true]")?.scrollIntoView({ inline: "center", block: "nearest" }); }, [date]);

  // refetch when area / sport / retry change (date and search are in the URL → server fetch)
  useEffect(() => {
    if (!loaded) return;
    const isDefault = !prefs.gov && !prefs.district && !prefs.sport && tick === 0 && !initialError;
    let alive = true;
    (async () => {
      if (isDefault) { await Promise.resolve(); if (alive) setRows(initial); return; }
      setBusy(true);
      const { data, error } = await createClient().rpc("club_day_slots", { p_date: date, p_sport: prefs.sport, p_governorate: prefs.gov, p_district: prefs.district, p_query: query.trim() || null });
      if (!alive) return;
      setBusy(false);
      if (error) { setRows(null); return; }
      setRows(data as DaySlot[]);
    })();
    return () => { alive = false; };
  }, [prefs, loaded, date, query, tick, initial, initialError]);
  const update = (p: Prefs) => { setPrefs(p); writePrefs(p); };

  // group by club → distinct start times
  const clubs = useMemo(() => {
    const m = new Map<string, { club: SheetClub; town: string | null; district: string | null; price_from: number | null; sports: string[]; times: Map<string, { id: string; name: string; free: number }[]> }>();
    for (const r of rows ?? []) {
      let c = m.get(r.club_id);
      if (!c) {
        c = { club: { id: r.club_id, name: r.club_name, slug: r.slug, slot_minutes: r.slot_minutes, min_minutes: r.min_minutes, max_minutes: r.max_minutes, service_fee_usd: Number(r.service_fee_usd), hold_minutes: r.hold_minutes, cancel_cutoff_hours: r.cancel_cutoff_hours, timezone: r.timezone }, town: r.town, district: r.district, price_from: r.price_from, sports: r.sports, times: new Map() };
        m.set(r.club_id, c);
      }
      const list = c.times.get(r.start_at) ?? [];
      list.push({ id: r.court_id, name: r.court_name, free: r.free_minutes });
      c.times.set(r.start_at, list);
    }
    return [...m.values()];
  }, [rows]);
  const sportsPresent = useMemo(() => new Set((rows ?? []).flatMap((r) => r.sports)), [rows]);
  const chips = sports.filter((s) => sportsPresent.has(s.code) || s.code === prefs.sport || prefs.sport === null && sportsPresent.size === 0);

  // coming back from sign-in: reopen the panel on the slot the player had chosen
  useEffect(() => {
    if (!resume || !rows) return;
    const t = setTimeout(() => {
      const r = rows.find((x) => x.court_id === resume.court && x.start_at === resume.at);
      const c = clubs.find((x) => x.club.id === r?.club_id);
      if (r && c) setSheet({ club: c.club, at: r.start_at, courts: c.times.get(r.start_at) ?? [], courtId: r.court_id, minutes: resume.dur });
      else router.replace(`/courts?date=${date}`);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const chip = (on: boolean) => `chip ${on ? "chip-on" : ""}`;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col">
      <div className="flex items-center justify-between px-5 pt-12">
        <div className="text-[13px] font-bold uppercase tracking-wider text-muted">{formatInTimeZone(dayOf(date), "Asia/Beirut", "MMM yyyy")}</div>
        <AreaPicker areas={areas} value={{ gov: prefs.gov, district: prefs.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district })} />
      </div>
      <div ref={stripRef} className="flex gap-1 overflow-x-auto px-3 pb-3 pt-3">
        {days.map((d) => {
          const on = d === date;
          return (
            <Link key={d} data-on={on} href={`/courts?date=${d}${query ? `&q=${encodeURIComponent(query)}` : ""}`} className="flex w-[50px] shrink-0 flex-col items-center gap-1.5 text-xs font-semibold">
              <span className="text-[#8a918e]">{d === today ? "Today" : formatInTimeZone(dayOf(d), "Asia/Beirut", "EEEEE")}</span>
              <span className={`flex h-10 w-10 items-center justify-center rounded-full text-[17px] font-bold ${on ? "bg-cedar text-white" : ""}`}>{formatInTimeZone(dayOf(d), "Asia/Beirut", "d")}</span>
            </Link>
          );
        })}
      </div>
      <div className="flex gap-2 overflow-x-auto border-t border-grid px-5 py-3">
        <button onClick={() => update({ ...prefs, sport: null })} className={chip(!prefs.sport)}>All sports</button>
        {chips.map((s) => <button key={s.code} onClick={() => update({ ...prefs, sport: prefs.sport === s.code ? null : s.code })} className={chip(prefs.sport === s.code)}>{s.name_en}</button>)}
      </div>
      <div className="flex items-baseline justify-between px-5 pt-1">
        <div className="text-lg font-bold">{date === today ? "Today" : formatInTimeZone(dayOf(date), "Asia/Beirut", "EEEE, d MMMM")}</div>
        <div className="text-[13px] text-muted">{prefs.sport ? `${sportName(prefs.sport)} · ` : ""}{clubs.length} club{clubs.length === 1 ? "" : "s"}</div>
      </div>
      {query && <form action="/courts" className="mx-5 mt-2 flex items-center gap-2 rounded-full border border-grid bg-white px-4 py-2 text-sm"><IconSearch size={18} className="text-muted" /><input name="q" defaultValue={query} className="flex-1 bg-transparent outline-none" /><input type="hidden" name="date" value={date} /><Link href={`/courts?date=${date}`} className="text-muted">✕</Link></form>}

      <div className={`flex flex-col gap-3.5 px-5 pb-28 pt-3.5 ${busy ? "opacity-60" : ""}`}>
        {rows === null && <p className="flex items-center justify-between rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">Could not load availability. <button onClick={() => setTick((n) => n + 1)} className="font-semibold underline">Retry</button></p>}
        {rows !== null && clubs.length === 0 && <p className="card p-6 text-center text-sm text-muted">No free courts for this day{prefs.sport ? ` in ${sportName(prefs.sport)}` : ""}. Try another day, sport or area.</p>}
        {clubs.map((c) => {
          const times = [...c.times.keys()].sort();
          const all = showAll[c.club.id];
          const shown = all ? times : times.slice(0, 6);
          return (
            <article key={c.club.id} className="card overflow-hidden">
              <Link href={`/club/${c.club.slug}?date=${date}`} className="flex items-center gap-3 p-4">
                <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{c.club.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[17px] font-bold">{c.club.name}</div>
                  <div className="text-sm text-muted">{[c.town, c.district].filter(Boolean).join(" · ") || "Lebanon"}{c.price_from != null ? ` · from $${Number(c.price_from).toFixed(0)}/h` : ""}{!prefs.sport && c.sports.length > 1 ? ` · ${c.sports.map(sportName).join(", ")}` : ""}</div>
                </div>
                <span className="text-muted">›</span>
              </Link>
              <div className="flex flex-wrap gap-2 border-t border-grid bg-[#fafaf8] px-4 py-3.5">
                {shown.map((at) => (
                  <button key={at} onClick={() => setSheet({ club: c.club, at, courts: c.times.get(at)!, courtId: c.times.get(at)![0].id, minutes: null })} className="min-w-[72px] rounded-xl bg-turf-soft px-3 py-3 text-[15px] font-bold text-turf-deep">{formatInTimeZone(new Date(at), c.club.timezone, "HH:mm")}</button>
                ))}
                {times.length > 6 && <button onClick={() => setShowAll({ ...showAll, [c.club.id]: !all })} className="self-center px-2 text-sm font-semibold text-turf">{all ? "Less" : `+${times.length - 6}`}</button>}
              </div>
            </article>
          );
        })}
      </div>

      {sheet && <BookSheet club={sheet.club} date={date} at={sheet.at} courts={sheet.courts} initialCourtId={sheet.courtId} initialMinutes={sheet.minutes} signedIn={signedIn} onClose={() => setSheet(null)} />}
    </main>
  );
}
