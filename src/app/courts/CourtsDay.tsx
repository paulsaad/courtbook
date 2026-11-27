"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import type { Governorate, Sport } from "@/lib/geo";
import { EMPTY, readPrefs, writePrefs, type Prefs } from "@/lib/prefs";
import { shiftDate } from "@/lib/time";
import AreaPicker from "@/components/AreaPicker";
import { SavedAreaChips } from "@/components/SavedAreas";
import FavouriteHeart, { FavouriteMessage } from "@/components/FavouriteHeart";
import { areaFromPrefs, prefsFromArea, usePlaying } from "@/lib/playing";
import { clubPoint, coarsen, distanceLabel, sortByDistance, type LatLng, type PlayingArea } from "@/lib/places";
import { IconSearch } from "@/components/Icons";
import BookSheet, { type SheetClub } from "./BookSheet";
import { placeLine } from "@/app/club/[slug]/ClubHeader";

export type DaySlot = {
  club_id: string; club_name: string; slug: string; town: string | null; district: string | null; price_from: number | null; sports: string[];
  slot_minutes: number; min_minutes: number; max_minutes: number; service_fee_usd: number; hold_minutes: number; cancel_cutoff_hours: number; timezone: string;
  court_id: string; court_name: string; court_sport: string; start_at: string; free_minutes: number; is_demo: boolean | null;
};
type Resume = { at: string; court: string; dur: number | null } | null;
type Sheet = { club: SheetClub; at: string; courts: { id: string; name: string; free: number }[]; courtId: string; minutes: number | null };

const TZ = "Asia/Beirut";
const reqKey = (d: string, q: string, p: Prefs) => `${d}|${q}|${p.gov ?? ""}|${p.district ?? ""}|${p.sport ?? ""}`;   // a town narrows the district's answer on the page

/**
 * Near me (website). The position is read only when the player taps "Near me" (or, when they chose it before and the
 * browser already allows it, without asking again). It is rounded to about 1 km, kept in this page's memory, and never
 * sent anywhere: distances are computed here against the clubs' public map points. Only the choice is remembered.
 */
type Near = { status: "off" | "locating" | "on" | "denied" | "unavailable"; origin: LatLng | null };
const NEAR_KEY = "cb_near";
const rememberNear = (on: boolean) => { try { if (on) localStorage.setItem(NEAR_KEY, "1"); else localStorage.removeItem(NEAR_KEY); } catch {} };
const nearChosen = () => { try { return localStorage.getItem(NEAR_KEY) === "1"; } catch { return false; } };
function locate(): Promise<LatLng | "denied" | "unavailable"> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { resolve("unavailable"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(coarsen({ lat: p.coords.latitude, lng: p.coords.longitude })),
      (e) => resolve(e.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 10 * 60_000 },
    );
  });
}

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
  const playing = usePlaying(signedIn);
  const [fromAccount, setFromAccount] = useState(false);
  const [near, setNear] = useState<Near>({ status: "off", origin: null });
  // M14 review B (same rule as the app): while Near me is on, the area being browsed never narrows the list; it is
  // kept and comes back when Near me is turned off. Choosing an area turns Near me off, and a location answer that
  // arrives after that (or after Near me was turned off) is dropped.
  const nearSeq = useRef(0);
  const nearOn = near.status === "on";
  const view: Prefs = nearOn ? { ...prefs, gov: null, district: null, town: null, townName: null } : prefs;
  const [points, setPoints] = useState<Map<string, LatLng> | null>(null);
  // the club points could not be read: the list is then not sorted, and must not say "Nearest first"
  const [pointsFailed, setPointsFailed] = useState(false);
  const days = Array.from({ length: 15 }, (_, i) => shiftDate(today, i));
  const dayOf = (d: string) => new Date(`${d}T12:00:00+02:00`);

  const key = reqKey(date, query, view);
  const rows: DaySlot[] | null | undefined = result.key === key ? result.rows : undefined;   // undefined = loading, null = failed
  const loading = rows === undefined;

  useEffect(() => { const t = setTimeout(() => { setPrefs(readPrefs()); setLoaded(true); }, 0); return () => clearTimeout(t); }, []);
  // the account's last area wins over this browser's, once (0088: the player may come from another device)
  useEffect(() => {
    if (fromAccount || !loaded || !playing.prefs) return;
    const t = setTimeout(() => {
      setFromAccount(true);
      const last = playing.prefs?.last ?? null;
      if (last && !query) setPrefs((p) => { const n = { ...p, ...prefsFromArea(last) }; writePrefs(n); return n; });
    }, 0);
    return () => clearTimeout(t);
  }, [playing.prefs, loaded, fromAccount, query]);
  // "Near me" chosen before: resume only if the browser already allows it (never a prompt on load)
  useEffect(() => {
    if (!loaded || !nearChosen() || typeof navigator === "undefined" || !navigator.permissions) return;
    let alive = true;
    const mine = ++nearSeq.current;
    navigator.permissions.query({ name: "geolocation" as PermissionName }).then((st) => {
      if (!alive || st.state !== "granted" || mine !== nearSeq.current) return;
      setNear({ status: "locating", origin: null });
      locate().then((r) => { if (alive && mine === nearSeq.current) setNear(typeof r === "string" ? { status: r, origin: null } : { status: "on", origin: r }); });
    }).catch(() => {});
    return () => { alive = false; };
  }, [loaded]);
  // the clubs' public map points, once, when Near me is on
  useEffect(() => {
    if (near.status !== "on" || points || pointsFailed) return;
    let alive = true;
    createClient().from("clubs").select("id, lat, lng").eq("active", true).then(({ data, error }) => {
      if (!alive) return;
      if (error || !data) { setPointsFailed(true); return; }
      const m = new Map<string, LatLng>();
      for (const r of (data ?? []) as { id: string; lat: unknown; lng: unknown }[]) { const p = clubPoint(r.lat, r.lng); if (p) m.set(r.id, p); }
      setPoints(m);
    });
    return () => { alive = false; };
  }, [near.status, points, pointsFailed]);
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
      const { data, error } = await createClient().rpc("club_day_slots", { p_date: date, p_sport: view.sport, p_governorate: view.gov, p_district: view.district, p_query: query.trim() || null });
      if (!alive) return;
      setBusy(false);
      setResult({ key, rows: error ? null : (data as DaySlot[]) });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded, retry]);
  // any change of day / area / sport / search closes an open booking panel
  useEffect(() => { const t = setTimeout(() => setSheet(null), 0); return () => clearTimeout(t); }, [key]);

  const update = (p: Prefs) => {
    if (p.gov !== prefs.gov || p.district !== prefs.district || p.town !== prefs.town) {
      playing.rememberArea(p);
      if (near.status !== "off") { nearSeq.current++; setNear({ status: "off", origin: null }); rememberNear(false); }   // an area replaces Near me
    }
    setPrefs(p); writePrefs(p);
  };
  const pickArea = (a: PlayingArea | null) => update({ ...prefs, ...prefsFromArea(a) });
  const startNear = async () => {
    if (near.status === "on") { nearSeq.current++; setNear({ status: "off", origin: null }); rememberNear(false); return; }
    const mine = ++nearSeq.current;
    setNear({ status: "locating", origin: null });
    const r = await locate();
    if (mine !== nearSeq.current) return;   // an area was chosen meanwhile: stay off
    if (typeof r === "string") { setNear({ status: r, origin: null }); rememberNear(false); return; }
    rememberNear(true);
    setNear({ status: "on", origin: r });   // the area is kept (not cleared, not sent to the account); `view` ignores it
  };

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
    // a saved town narrows its district's answer (club_day_slots filters by district; the town by name)
    const list = [...m.values()].filter((c) => !view.townName || c.town === view.townName);
    if (near.status !== "on" || !near.origin || !points) return list.map((c) => ({ ...c, km: null as number | null }));
    return sortByDistance(list.map((c) => ({ ...c, id: c.club.id })), points, near.origin).map(({ item, km }) => ({ ...item, km }));
  }, [rows, view.townName, near, points]);
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
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-3xl flex-col">
      <div className="flex items-center justify-between px-5 pt-12">
        <div className="text-[13px] font-bold uppercase tracking-wider text-muted">{formatInTimeZone(dayOf(date), TZ, "MMM yyyy")}</div>
        <AreaPicker areas={areas} value={{ gov: view.gov, district: view.district }} onChange={(a) => update({ ...prefs, gov: a.gov, district: a.district, town: null, townName: null })} />
      </div>
      <div className="flex items-center gap-2 overflow-x-auto px-5 pt-1">
        <button type="button" onClick={startNear} aria-pressed={near.status === "on"} disabled={near.status === "locating"} className={`chip shrink-0 ${near.status === "on" ? "chip-on" : ""}`}>
          {near.status === "locating" ? "Finding you…" : "Near me"}
        </button>
        {view.townName && <span className="shrink-0 text-[13px] text-muted">Town: {view.townName}</span>}
      </div>
      {(near.status === "denied" || near.status === "unavailable") && (
        <p className="mx-5 mt-2 rounded-xl bg-sand-soft px-3 py-2 text-sm">
          {near.status === "denied" ? "Location is off for CourtBook in this browser. Choose an area instead, or allow location and tap Near me again." : "Couldn't find your location. Choose an area instead."}
        </p>
      )}
      <div className="pt-2"><SavedAreaChips prefs={playing.prefs} govs={areas} current={areaFromPrefs(prefs)} none={nearOn} onPick={pickArea} /></div>
      <FavouriteMessage signedIn={signedIn} />
      <div ref={stripRef} className="flex gap-1 overflow-x-auto px-3 pb-3 pt-3">
        {days.map((d) => {
          const on = d === date;
          return (
            <button key={d} data-on={on} onClick={() => setDate(d)} className="flex w-[50px] shrink-0 flex-col items-center gap-1.5 text-xs font-semibold">
              <span className="text-muted">{d === today ? "Today" : formatInTimeZone(dayOf(d), TZ, "EEEEE")}</span>
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
        <input value={typed} onChange={(e) => setTyped(e.target.value)} enterKeyHint="search" placeholder="Club or town" className="min-w-0 flex-1 bg-transparent text-base outline-none" />
        {typed && <button type="button" onClick={() => { setTyped(""); setQuery(""); }} aria-label="Clear" className="px-1 text-muted">✕</button>}
      </form>
      {query && <div className="px-5 pt-2 text-[13px] text-muted">Showing clubs matching “{query}”</div>}
      {near.status === "on" && points && <div className="px-5 pt-2 text-[13px] text-muted">Nearest first. Distances are straight-line, not by road.</div>}
      {near.status === "on" && pointsFailed && (
        <p className="mx-5 mt-2 flex items-center justify-between gap-2 rounded-xl bg-sand-soft px-3 py-2 text-sm">
          Couldn&apos;t load club locations, so the list isn&apos;t sorted by distance.
          <button type="button" onClick={() => setPointsFailed(false)} className="shrink-0 font-semibold underline">Try again</button>
        </p>
      )}
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
              <div className="flex items-center pr-2">
              <Link href={`/club/${c.club.slug}?date=${date}`} className="flex min-w-0 flex-1 items-center gap-3 p-4">
                <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{c.club.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[17px] font-bold leading-tight">{c.club.name}</div>
                  {/* Courts is its own list of clubs; the label has to reach it too, in words,
                      the same as Home and the club page. */}
                  {c.is_demo && (
                    <span className="mt-0.5 inline-block rounded-full bg-sand-soft px-2 py-0.5 text-[11px] font-semibold text-sand">Fictional demo club</span>
                  )}
                  <div className="text-sm text-muted">{c.km != null && <span aria-label={distanceLabel(c.km).a11y}>{distanceLabel(c.km).text} · </span>}{placeLine(c.town, c.district)}{c.price_from != null ? ` · from $${Number(c.price_from).toFixed(0)}/h` : ""}{!prefs.sport && c.sports.length > 1 ? ` · ${c.sports.map(sportName).join(", ")}` : ""}</div>
                </div>
                <span className="text-muted">›</span>
              </Link>
              <FavouriteHeart clubId={c.club.id} clubName={c.club.name} slug={c.club.slug} signedIn={signedIn} />
              </div>
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
