"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { bookingDate, clubLocalToUtc, dayBounds, hhmm, moveTarget, nowMs, shiftDate, slotTimes, todayIn, toMin, weekStart } from "@/lib/time";
import { friendlyError, type Block, type Booking, type Club, type Court } from "@/lib/types";
import { blockSlotOptions, bookingSlotOptions, pickSlots } from "./durations";

type Props = { club: Club; courts: Court[]; bookings: Booking[]; blocks: Block[]; date: string; view: StaffView; sport: string | null; court: string | null; loadFailed?: boolean; sportNames: Record<string, string> };

export type StaffView = "now" | "grid" | "week" | "list";
/** One active court's state at this moment: busy by a booking, an unexpired hold or a block.
 *  free_at follows the chain of back-to-back bookings and blocks to when the court is really free. */
type FreeNow = { court_id: string; court_name: string; sport: string; busy: boolean; free_at: string | null };
/** A past customer of this club. Name and phone only — never a player account. */
type Guest = { name: string; phone: string | null; last_at: string };

type Sheet =
  | { kind: "add"; courtId: string; time: string; date?: string }
  | { kind: "booking"; booking: Booking }
  | { kind: "block"; block: Block }
  | { kind: "close" }
  | null;


/** Staff see who booked and how to reach them: the desk's whole job is ringing people.
 *  Scoped in the database to staff of this club and bookings at this club. */
async function withContacts(
  supabase: ReturnType<typeof createClient>,
  clubId: string,
  rows: Record<string, unknown>[],
): Promise<Booking[]> {
  const ids = rows.map((r) => r.id as string);
  if (!ids.length) return [] as Booking[];
  const { data } = await supabase.rpc("club_booking_contacts", { p_club: clubId, p_bookings: ids });
  const by = new Map((data as { booking_id: string; name: string | null; phone: string | null }[] | null ?? [])
    .map((c) => [c.booking_id, c] as const));
  return rows.map((r) => ({
    ...r,
    player_name: by.get(r.id as string)?.name ?? null,
    contact_phone: by.get(r.id as string)?.phone ?? null,
  })) as unknown as Booking[];
}

export default function DayCalendar({ club, courts: allCourts, bookings: initialBookings, blocks: initialBlocks, date, view, sport, court: courtParam, loadFailed, sportNames }: Props) {
  // multi-sport clubs get a sport filter; single-sport clubs never see it
  const sports = [...new Set(allCourts.map((c) => c.sport))];
  const courts = sport && sports.includes(sport) ? allCourts.filter((c) => c.sport === sport) : allCourts;
  const [bookings, setBookings] = useState(initialBookings);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMin, setNowMin] = useState<number | null>(null);
  const [freeNow, setFreeNow] = useState<FreeNow[] | null>(null);
  const [showLater, setShowLater] = useState(false);
  const [commonMins, setCommonMins] = useState<number | null>(null);
  const [week, setWeek] = useState<{ key: string; bookings: Booking[]; blocks: Block[] } | null>(null);
  const [refresh, setRefresh] = useState(0);
  // A read that failed leaves the grid showing whatever it had, so occupied slots could look free.
  // The day and the week are verified separately: one succeeding says nothing about the other, and
  // adding stays off while a read is still in flight, not just when one has already failed.
  const [dayError, setDayError] = useState(Boolean(loadFailed));
  const [weekError, setWeekError] = useState(false);
  const [dayLoading, setDayLoading] = useState(false);
  const [weekLoading, setWeekLoading] = useState(false);
  // Day reads come from the Now timer, from Retry and from every action. Without a sequence number an
  // older answer landing late would overwrite newer rows and clear the loading flag of a read still
  // in flight — so only the newest request may touch state.
  const dayReq = useRef(0);

  // week view shows one court at a time: seven columns is all a phone has room for
  const weekCourt = courts.find((c) => c.id === courtParam) ?? courts[0] ?? null;
  const wkStart = weekStart(date);
  const weekDays = Array.from({ length: 7 }, (_, i) => shiftDate(wkStart, i));

  // the sport filter must narrow the bookings too, not just which courts are drawn
  const shownCourtIds = new Set(courts.map((c) => c.id));
  const shownBookings = bookings.filter((b) => b.court_id && shownCourtIds.has(b.court_id));

  const times = slotTimes(club.open_time, club.close_time, club.slot_minutes);
  const openMin = toMin(club.open_time);
  const ROW_PX = club.slot_minutes <= 30 ? 36 : club.slot_minutes <= 60 ? 56 : 64;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1; // label hours only on a 30-min grid
  const isToday = date === todayIn(club.timezone);

  // red now-line (today only)
  useEffect(() => {
    if (!isToday) return;
    const tick = () => setNowMin(toMin(formatInTimeZone(new Date(), club.timezone, "HH:mm")));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [isToday, club.timezone]);

  // Refetch only the day's rows from the browser: faster than re-rendering the page.
  const reload = useCallback(async () => {
    const seq = ++dayReq.current;
    setDayLoading(true);
    const supabase = createClient();
    const { dayStart, dayEnd } = dayBounds(date, club.timezone);
    const [{ data: b, error: eb }, { data: k, error: ek }] = await Promise.all([
      supabase.from("bookings").select("id, court_id, player_id, guest_name, guest_phone, start_at, end_at, status, source, credit_tx_id, price_usd, fee_usd, hold_expires_at")
        .eq("club_id", club.id).or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`).not("court_id", "is", null).lt("start_at", dayEnd).gt("end_at", dayStart).order("start_at"),
      supabase.from("blocks").select("id, court_id, start_at, end_at, reason").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
    ]);
    if (seq !== dayReq.current) return;                                  // a newer read owns the state now
    if (eb || ek) { setDayError(true); setDayLoading(false); return; }   // keep what we had rather than showing free slots
    const rows = await withContacts(supabase, club.id, b ?? []);
    if (seq !== dayReq.current) return;                                  // and again, after the second await
    setBookings(rows);
    setBlocks((k ?? []) as Block[]);
    setDayError(false);
    setDayLoading(false);
  }, [club.id, club.timezone, date]);

  // Now view: which courts are usable this minute, refreshed with the clock. The server decides what
  // "busy" means (booking, unexpired hold or block) so the rule lives in one place.
  useEffect(() => {
    if (view !== "now") return;
    let alive = true;
    const load = async () => {
      const { data } = await createClient().rpc("club_courts_free_now", { p_club: club.id });
      if (alive && data) setFreeNow(data as FreeNow[]);
      if (alive) await reload();
    };
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [view, club.id, reload]);

  // week view: one query for the whole week, keyed so a stale answer can never be shown
  useEffect(() => {
    if (view !== "week" || !weekCourt) return;
    const key = `${wkStart}|${weekCourt.id}`;
    let alive = true;
    (async () => {
      setWeekLoading(true);
      const supabase = createClient();
      const from = dayBounds(wkStart, club.timezone).dayStart;
      const to = dayBounds(shiftDate(wkStart, 6), club.timezone).dayEnd;
      const [{ data: b, error: eb }, { data: k, error: ek }] = await Promise.all([
        supabase.from("bookings").select("id, court_id, player_id, guest_name, guest_phone, start_at, end_at, status, source, credit_tx_id, price_usd, fee_usd, hold_expires_at")
          .eq("club_id", club.id).eq("court_id", weekCourt.id)
          .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`)
          .lt("start_at", to).gt("end_at", from).order("start_at"),
        supabase.from("blocks").select("id, court_id, start_at, end_at, reason")
          .eq("club_id", club.id).eq("court_id", weekCourt.id).lt("start_at", to).gt("end_at", from),
      ]);
      if (eb || ek) { if (alive) { setWeekError(true); setWeekLoading(false); } return; }
      const rows = await withContacts(supabase, club.id, b ?? []);
      if (!alive) return;
      setWeek({ key, bookings: rows, blocks: (k ?? []) as Block[] });
      setWeekError(false);
      setWeekLoading(false);
    })();
    return () => { alive = false; };
  }, [view, club.id, club.timezone, wkStart, weekCourt, refresh]);

  // the duration this club books most often, so the walk-in sheet opens on it
  useEffect(() => {
    let alive = true;
    createClient().rpc("club_common_duration", { p_club: club.id }).then(({ data }) => {
      if (alive && typeof data === "number") setCommonMins(data);
    });
    return () => { alive = false; };
  }, [club.id]);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    if (error) {
      setBusy(false);
      setError(friendlyError(error.message));
      return;
    }
    await reload();
    setRefresh((n) => n + 1);   // the week view holds its own copy of the rows
    setBusy(false);
    setSheet(null);
  }

  /** grid row index (0-based) and span for an interval, clamped to the day */
  function place(startAt: string, endAt: string) {
    const s = toMin(hhmm(startAt, club.timezone));
    const sameDay = formatInTimeZone(parseISO(endAt), club.timezone, "yyyy-MM-dd") === date;
    const e = sameDay ? toMin(hhmm(endAt, club.timezone)) : 24 * 60;
    const startDay = formatInTimeZone(parseISO(startAt), club.timezone, "yyyy-MM-dd") === date ? s : openMin;
    const row = Math.max(0, Math.floor((startDay - openMin) / club.slot_minutes));
    const endRow = Math.min(times.length, Math.ceil((e - openMin) / club.slot_minutes));
    return { row, span: Math.max(1, endRow - row) };
  }

  // only the view being looked at decides whether its rows can be trusted
  const viewError = view === "week" ? weekError : dayError;
  const viewLoading = view === "week" ? weekLoading : dayLoading;
  const canAdd = !viewError && !viewLoading;

  const q = (d: string, v: string, sp: string | null, ct?: string | null) =>
    `/staff/${club.slug}?date=${d}&view=${v}${sp ? `&sport=${sp}` : ""}${ct ? `&court=${ct}` : ""}`;
  const nav = (d: string) => q(d, view, sport, view === "week" ? weekCourt?.id : null);
  const dayNum = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "d");
  const dayName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "EEEE");
  const monthName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "MMMM yyyy");
  const courtName = (id: string | null) => courts.find((c) => c.id === id)?.name ?? "";

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <header className="sticky top-0 z-10 bg-paper/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 pt-3 text-sm">
          <Link href="/" className="text-muted">‹ {club.name}</Link>
          <div className="flex gap-4"><Link href={`/staff/${club.slug}/payments`} className="text-muted">Payments</Link><Link href={`/staff/${club.slug}/settings`} className="text-muted">Settings</Link><button onClick={() => setSheet({ kind: "close" })} className="text-danger">Close courts…</button></div>
        </div>
        <div className="flex items-end justify-between px-4 pb-3 pt-1">
          {view === "week" ? (
            <div className="leading-tight">
              <div className="text-2xl font-semibold tracking-tight">Week of {formatInTimeZone(clubLocalToUtc(wkStart, "12:00", club.timezone), club.timezone, "d MMM")}</div>
              <div className="text-sm text-muted">{weekCourt?.name ?? "No courts"}</div>
            </div>
          ) : (
            <div className="flex items-end gap-3">
              <span className="text-5xl font-semibold leading-none tracking-tight">{dayNum}</span>
              <div className="pb-0.5 leading-tight">
                <div className="font-medium">{dayName}</div>
                <div className="text-sm text-muted">{monthName}</div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Link href={nav(shiftDate(date, view === "week" ? -7 : -1))} aria-label={view === "week" ? "Previous week" : "Previous day"} className="grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg">‹</Link>
            <Link href={nav(todayIn(club.timezone))} className={`h-10 rounded-full px-3 text-sm leading-10 ${isToday ? "text-muted" : "border border-grid bg-white"}`}>{view === "week" ? "This week" : "Today"}</Link>
            <Link href={nav(shiftDate(date, view === "week" ? 7 : 1))} aria-label={view === "week" ? "Next week" : "Next day"} className="grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg">›</Link>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="flex rounded-full border border-grid bg-white p-0.5 text-sm">
            <Link href={q(todayIn(club.timezone), "now", sport)} className={`rounded-full px-4 py-1.5 ${view === "now" ? "bg-ink text-white" : ""}`}>Now</Link>
            <Link href={q(date, "grid", sport)} className={`rounded-full px-4 py-1.5 ${view === "grid" ? "bg-ink text-white" : ""}`}>Courts</Link>
            <Link href={q(date, "week", sport, weekCourt?.id)} className={`rounded-full px-4 py-1.5 ${view === "week" ? "bg-ink text-white" : ""}`}>Week</Link>
            <Link href={q(date, "list", sport)} className={`rounded-full px-4 py-1.5 ${view === "list" ? "bg-ink text-white" : ""}`}>List</Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-turf" />app</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-sand" />desk</span>
          </div>
        </div>
        {sports.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto px-4 pb-3">
            <Link href={q(date, view, null)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs leading-9 ${!sport ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>All sports</Link>
            {sports.map((sp) => (
              <Link key={sp} href={q(date, view, sp)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs leading-9 ${sport === sp ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{sportNames[sp] ?? sp}</Link>
            ))}
          </div>
        )}
        {view === "week" && courts.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto px-4 pb-3">
            {courts.map((c) => (
              <Link key={c.id} href={q(date, "week", sport, c.id)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs leading-9 ${weekCourt?.id === c.id ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{c.name}</Link>
            ))}
          </div>
        )}
      </header>

      {viewError && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-danger/40 bg-red-50 px-3 py-2 text-sm text-danger">
          <span className="flex-1">Couldn&apos;t load the latest {view === "week" ? "week" : "bookings"}. What you see may be out of date, so adding is off until this works.</span>
          {/* the flag is cleared by a successful read, never by tapping Retry */}
          <button disabled={viewLoading} onClick={() => { setRefresh((n) => n + 1); void reload(); }} className="shrink-0 rounded-lg border border-danger/40 px-3 py-1 disabled:opacity-50">{viewLoading ? "Checking…" : "Retry"}</button>
        </div>
      )}

      {view === "week" ? (
        <WeekGrid
          club={club} court={weekCourt} days={weekDays} times={times} today={todayIn(club.timezone)}
          data={week && week.key === `${wkStart}|${weekCourt?.id}` ? week : null}
          canAdd={canAdd}
          dayHref={(d) => q(d, "grid", sport)}
          onOpenBooking={(b) => setSheet({ kind: "booking", booking: b })}
          onOpenBlock={(bl) => setSheet({ kind: "block", block: bl })}
          onAdd={(d, t) => { if (weekCourt) setSheet({ kind: "add", courtId: weekCourt.id, time: t, date: d }); }}
        />
      ) : view === "now" ? (
        <NowPanel
          club={club} courts={courts} bookings={shownBookings} freeNow={freeNow} sportNames={sportNames}
          showLater={showLater} onToggleLater={() => setShowLater((v) => !v)}
          onOpen={(b) => setSheet({ kind: "booking", booking: b })}
        />
      ) : view === "grid" ? (
        <div className="flex-1 overflow-x-auto px-2 pb-24">
          <div className="flex min-w-max">
            {/* time axis */}
            <div className="relative w-12 shrink-0" style={{ height: times.length * ROW_PX, marginTop: 36 }}>
              {times.map((t, i) => i % labelEvery === 0 && (
                <div key={t} className="absolute right-2 -translate-y-1/2 text-xs text-muted" style={{ top: i * ROW_PX }}>{t}</div>
              ))}
            </div>
            {/* courts */}
            <div className="grid flex-1 gap-x-1.5" style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(7rem, 1fr))` }}>
              {courts.map((c) => (
                <div key={c.id} className="h-9 px-1 text-center text-sm">
                  <div className="font-medium leading-tight">{c.name}</div>
                  <div className="text-xs text-muted">{sportNames[c.sport] ?? c.sport}</div>
                </div>
              ))}
              {courts.map((c) => (
                <div key={c.id} className="relative rounded-lg border border-grid bg-white" style={{ height: times.length * ROW_PX }}>
                  {/* empty slots */}
                  {times.map((t, i) => (
                    <button
                      key={t}
                      onClick={() => setSheet({ kind: "add", courtId: c.id, time: t })}
                      disabled={!canAdd}
                      aria-label={`Add booking ${c.name} ${t}`}
                      className={`absolute inset-x-0 border-t first:border-t-0 active:bg-slate-soft ${i % labelEvery === 0 ? "border-grid" : "border-grid/50 border-dashed"}`}
                      style={{ top: i * ROW_PX, height: ROW_PX }}
                    />
                  ))}
                  {/* blocks */}
                  {blocks.filter((k) => k.court_id === c.id).map((k) => {
                    const p = place(k.start_at, k.end_at);
                    return (
                      <button key={k.id} onClick={() => setSheet({ kind: "block", block: k })}
                        className="hatch absolute inset-x-1 rounded-md border border-grid bg-slate-soft px-2 py-1 text-left text-xs text-muted"
                        style={{ top: p.row * ROW_PX + 2, height: p.span * ROW_PX - 4 }}>
                        {k.reason ?? "Blocked"}
                      </button>
                    );
                  })}
                  {/* bookings */}
                  {bookings.filter((b) => b.court_id === c.id).map((b) => {
                    const p = place(b.start_at, b.end_at);
                    const app = b.source === "app";
                    const pending = b.status === "pending";
                    return (
                      <button key={b.id} onClick={() => setSheet({ kind: "booking", booking: b })}
                        className={`absolute inset-x-1 overflow-hidden rounded-md border-l-4 px-2 py-1 text-left text-xs ${pending ? "border-dashed border-turf bg-white" : app ? "border-turf bg-turf-soft" : "border-sand bg-sand-soft"}`}
                        style={{ top: p.row * ROW_PX + 2, height: p.span * ROW_PX - 4 }}>
                        <div className="truncate text-sm font-medium">{pending ? "Paying…" : b.guest_name ?? b.player_name ?? "Player"}</div>
                        <div className="text-muted">{hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)}</div>
                      </button>
                    );
                  })}
                  {/* now line */}
                  {nowMin !== null && nowMin >= openMin && nowMin <= openMin + times.length * club.slot_minutes && (
                    <div className="pointer-events-none absolute inset-x-0 border-t-2 border-danger" style={{ top: ((nowMin - openMin) / club.slot_minutes) * ROW_PX }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <ul className="mx-4 mb-24 divide-y divide-grid rounded-xl border border-grid bg-white">
          {shownBookings.length === 0 && <li className="p-8 text-center text-muted">No bookings this day. Tap a court slot in Courts view to add one.</li>}
          {shownBookings.map((b) => (
            <li key={b.id}>
              <button onClick={() => setSheet({ kind: "booking", booking: b })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className={`h-10 w-1 rounded ${b.source === "app" ? "bg-turf" : "bg-sand"}`} />
                <div className="w-28 shrink-0">
                  <div className="font-medium">{hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)}</div>
                  <div className="text-sm text-muted">{courtName(b.court_id)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{b.guest_name ?? b.player_name ?? "Player"}</div>
                  {b.guest_phone && <div className="text-sm text-muted">{b.guest_phone}</div>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sheet && (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-ink/30" onClick={() => !busy && setSheet(null)}>
          <div className="sheet-enter w-full max-w-lg rounded-t-2xl bg-white px-5 pb-8 pt-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-grid" />
            {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

            {sheet.kind === "add" && (
              <AddSheet
                club={club} court={courts.find((c) => c.id === sheet.courtId)!} time={sheet.time} busy={busy}
                defaultMinutes={commonMins}
                onSave={(name, phone, slots, asBlock) =>
                  run(async () => {
                    const supabase = createClient();
                    // in the week view the slot belongs to the column's day, not the page's date
                    const start = clubLocalToUtc(sheet.date ?? date, sheet.time, club.timezone);
                    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
                    if (asBlock) {
                      const { data: { user } } = await supabase.auth.getUser();
                      return supabase.from("blocks").insert({ club_id: club.id, court_id: sheet.courtId, start_at: start.toISOString(), end_at: end.toISOString(), reason: name || "Blocked", created_by: user!.id });
                    }
                    // the database checks staff rights, the court, the hours, the grid and the duration, and prices it
                    return supabase.rpc("staff_book", {
                      p_club: club.id, p_court: sheet.courtId,
                      p_start: start.toISOString(), p_end: end.toISOString(),
                      p_name: name, p_phone: phone || null,
                    });
                  })
                }
              />
            )}

            {sheet.kind === "booking" && (
              <BookingSheet
                club={club} courts={allCourts} booking={sheet.booking} times={times} busy={busy}
                onMove={(courtId, time, slots) =>
                  run(() => {
                    // the day comes from the booking, never from the page: the sheet can be opened
                    // from a week whose URL says another day (covered by src/lib/time.test.ts)
                    const { start, end } = moveTarget(sheet.booking.start_at, club.timezone, time, slots, club.slot_minutes);
                    return createClient().rpc("move_booking", { p_booking: sheet.booking.id, p_court: courtId, p_start: start.toISOString(), p_end: end.toISOString() });
                  })
                }
                onCancel={(clubCaused) => run(() => createClient().rpc("cancel_booking", { p_booking: sheet.booking.id, p_club_caused: clubCaused }))}
                onNoShow={() => run(() => createClient().rpc("mark_no_show", { p_booking: sheet.booking.id }))}
              />
            )}

            {sheet.kind === "block" && (
              <div className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">{sheet.block.reason ?? "Blocked"}</h2>
                <p className="text-sm text-muted">{courtName(sheet.block.court_id)} · {hhmm(sheet.block.start_at, club.timezone)}–{hhmm(sheet.block.end_at, club.timezone)}</p>
                <button disabled={busy} onClick={() => run(() => createClient().from("blocks").delete().eq("id", sheet.block.id))} className={secondaryDanger}>Remove block</button>
              </div>
            )}

            {sheet.kind === "close" && (
              <CloseSheet
                club={club} times={times} busy={busy}
                onClose={(from, to, reason) =>
                  run(() =>
                    createClient().rpc("close_club", {
                      p_club: club.id,
                      p_start: clubLocalToUtc(date, from, club.timezone).toISOString(),
                      p_end: clubLocalToUtc(date, to, club.timezone).toISOString(),
                      p_reason: reason || "Closed",
                    })
                  )
                }
              />
            )}
          </div>
        </div>
      )}
    </main>
  );
}

const input = "rounded-xl border border-grid bg-paper px-4 py-3 text-base outline-none focus:border-action focus:ring-2 focus:ring-action/20";
const select = "rounded-xl border border-grid bg-paper px-3 py-2 text-base";
const primary = "rounded-xl bg-action py-3.5 text-base font-medium text-white disabled:opacity-50";
const secondary = "rounded-xl border border-grid py-3.5 text-base";
const secondaryDanger = "rounded-xl border border-danger/40 py-3.5 text-base text-danger";
const backLink = "py-2 text-sm text-muted";

function fmtDur(m: number) {
  return m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`;
}

function closeMinutes(club: Club) {
  return club.close_time.startsWith("24:") ? 1440 : toMin(club.close_time);
}

/** One court, seven days. Days are columns because seven of them fit a phone and five courts do not.
 *  Time labels stay in a sticky gutter, a cell opens the usual sheets, and a column header opens that
 *  day in the Courts view, which is where names and controls are readable. */
function WeekGrid({ club, court, days, times, today, data, canAdd, dayHref, onOpenBooking, onOpenBlock, onAdd }: {
  club: Club; court: Court | null; days: string[]; times: string[]; today: string;
  data: { bookings: Booking[]; blocks: Block[] } | null;
  canAdd: boolean;
  dayHref: (d: string) => string;
  onOpenBooking: (b: Booking) => void;
  onOpenBlock: (b: Block) => void;
  onAdd: (date: string, time: string) => void;
}) {
  if (!court) return <p className="px-4 py-10 text-center text-sm text-muted">No active courts for this sport.</p>;
  const loading = data === null;
  const rowPx = club.slot_minutes <= 30 ? 34 : 48;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1;

  // what sits on this court at this day and time, if anything
  const at = (d: string, t: string) => {
    if (!data) return null;
    const ms = clubLocalToUtc(d, t, club.timezone).getTime();
    const b = data.bookings.find((x) => Date.parse(x.start_at) <= ms && Date.parse(x.end_at) > ms);
    if (b) return { kind: "booking" as const, b };
    const k = data.blocks.find((x) => Date.parse(x.start_at) <= ms && Date.parse(x.end_at) > ms);
    return k ? { kind: "block" as const, k } : null;
  };
  const isStart = (d: string, t: string, startAt: string) =>
    Math.abs(clubLocalToUtc(d, t, club.timezone).getTime() - Date.parse(startAt)) < 60_000;
  const busyCount = (d: string) => times.filter((t) => at(d, t) !== null).length;

  return (
    <div className={`mb-24 overflow-x-auto ${loading ? "pointer-events-none opacity-50" : ""}`}>
      <div className="min-w-[340px] px-2">
        <div className="grid" style={{ gridTemplateColumns: `3rem repeat(7, minmax(2.5rem, 1fr))` }}>
          <div className="sticky left-0 z-10 bg-paper" />
          {days.map((d) => (
            <Link key={d} href={dayHref(d)} className={`border-b border-grid pb-1 text-center text-xs leading-tight ${d === today ? "font-semibold text-turf" : "text-muted"}`}>
              <div>{formatInTimeZone(clubLocalToUtc(d, "12:00", club.timezone), club.timezone, "EEE")}</div>
              <div className="text-sm text-ink">{formatInTimeZone(clubLocalToUtc(d, "12:00", club.timezone), club.timezone, "d")}</div>
              <div className="tabular-nums">{loading ? "·" : `${busyCount(d)}/${times.length}`}</div>
            </Link>
          ))}

          {times.map((t, i) => (
            <div key={t} className="contents">
              <div className="sticky left-0 z-10 bg-paper pr-1 text-right text-[11px] text-muted" style={{ height: rowPx }}>
                {i % labelEvery === 0 ? t : ""}
              </div>
              {days.map((d) => {
                const cell = at(d, t);
                if (!cell) {
                  return (
                    <button key={d + t} onClick={() => onAdd(d, t)} disabled={!canAdd} aria-label={`Add a booking on ${d} at ${t}`}
                            className="border-b border-l border-grid/60 bg-white disabled:cursor-not-allowed" style={{ height: rowPx }} />
                  );
                }
                if (cell.kind === "block") {
                  return (
                    <button key={d + t} onClick={() => onOpenBlock(cell.k)} aria-label={`Blocked on ${d} at ${t}`}
                            className="border-b border-l border-grid/60 bg-[repeating-linear-gradient(45deg,#e7e5e4_0,#e7e5e4_3px,#fff_3px,#fff_6px)]" style={{ height: rowPx }} />
                  );
                }
                const b = cell.b;
                const head = isStart(d, t, b.start_at);
                return (
                  <button key={d + t} onClick={() => onOpenBooking(b)}
                          aria-label={`${b.guest_name ?? b.player_name ?? "Player"} on ${d} at ${hhmm(b.start_at, club.timezone)}`}
                          className={`relative border-l border-grid/60 ${head ? "border-t" : ""} ${b.status === "pending" ? "border-dashed bg-sand/40" : b.source === "app" ? "bg-turf-soft" : "bg-sand"}`}
                          style={{ height: rowPx }}>
                    {head && (
                      <span className="absolute inset-x-0 top-0.5 truncate px-0.5 text-[10px] font-medium leading-tight">
                        {b.status === "pending" ? "pay…" : (b.guest_name ?? b.player_name ?? "Player").split(" ")[0]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="px-2 py-3 text-xs text-muted">Tap a booking for its details, or a day at the top to open that day court by court.</p>
      </div>
    </div>
  );
}

/** What the desk sees when it opens the calendar: on court now, next three hours, then the rest. */
function NowPanel({ club, courts, bookings, freeNow, sportNames, showLater, onToggleLater, onOpen }: {
  club: Club; courts: Court[]; bookings: Booking[]; freeNow: FreeNow[] | null; sportNames: Record<string, string>;
  showLater: boolean; onToggleLater: () => void; onOpen: (b: Booking) => void;
}) {
  const now = nowMs();
  const live = bookings.filter((b) => Date.parse(b.start_at) <= now && Date.parse(b.end_at) > now);
  const soon = bookings.filter((b) => Date.parse(b.start_at) > now && Date.parse(b.start_at) <= now + 3 * 3600_000);
  const later = bookings.filter((b) => Date.parse(b.start_at) > now + 3 * 3600_000);
  const shown = new Set(courts.map((c) => c.id));
  const mine = (freeNow ?? []).filter((f) => shown.has(f.court_id));
  const free = mine.filter((f) => !f.busy);
  const name = (b: Booking) => (b.status === "pending" ? "Paying…" : b.guest_name ?? b.player_name ?? "Player");
  const courtName = (id: string | null) => courts.find((c) => c.id === id)?.name ?? "";
  const mins = (ms: number) => Math.max(0, Math.round(ms / 60000));

  const row = (b: Booking, trailing: React.ReactNode) => (
    <li key={b.id}>
      <button onClick={() => onOpen(b)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`h-10 w-1 shrink-0 rounded ${b.source === "app" ? "bg-turf" : "bg-sand"}`} />
        <div className="w-24 shrink-0">
          <div className="font-medium">{hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)}</div>
          <div className="text-sm text-muted">{courtName(b.court_id)}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{name(b)}</div>
          {(b.contact_phone ?? b.guest_phone) && <span className="text-sm text-action underline">{b.contact_phone ?? b.guest_phone}</span>}
        </div>
        <span className="shrink-0 text-xs text-muted">{trailing}</span>
      </button>
    </li>
  );

  return (
    <div className="mx-4 mb-24 flex flex-col gap-4">
      <section className="card p-4">
        {mine.length === 0 ? (
          <p className="text-sm text-muted">No active courts.</p>
        ) : (
          <>
            <div className="text-lg font-bold">{free.length} of {mine.length} court{mine.length === 1 ? "" : "s"} free right now</div>
            <p className="mt-0.5 text-xs text-muted">Right this minute — a court counts as busy if it has a booking, a booking still being paid for, or a block.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {mine.map((f) => (
                <span key={f.court_id} className={`rounded-full border px-3 py-1 text-xs ${f.busy ? "border-grid bg-paper text-muted" : "border-turf bg-turf-soft text-turf"}`}>
                  {f.court_name}{f.busy ? ` · free ${f.free_at ? hhmm(f.free_at, club.timezone) : "later"}` : " · free"}
                </span>
              ))}
            </div>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-muted">On court now</h2>
        <ul className="divide-y divide-grid rounded-xl border border-grid bg-white">
          {live.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Nothing on court.</li>}
          {live.map((b) => row(b, `${mins(Date.parse(b.end_at) - now)} min left`))}
        </ul>
      </section>

      <section>
        <h2 className="mb-1.5 px-1 text-sm font-semibold uppercase tracking-wide text-muted">Next three hours</h2>
        <ul className="divide-y divide-grid rounded-xl border border-grid bg-white">
          {soon.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">Nothing booked in the next three hours.</li>}
          {soon.map((b) => row(b, `in ${mins(Date.parse(b.start_at) - now)} min`))}
        </ul>
      </section>

      {later.length > 0 && (
        <section>
          <button onClick={onToggleLater} className="w-full px-1 py-2 text-left text-sm font-semibold uppercase tracking-wide text-muted">
            Later today ({later.length}) {showLater ? "▴" : "▾"}
          </button>
          {showLater && (
            <ul className="divide-y divide-grid rounded-xl border border-grid bg-white">
              {later.map((b) => row(b, sportNames[courts.find((c) => c.id === b.court_id)?.sport ?? ""] ?? ""))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

export function AddSheet({ club, court, time, busy, defaultMinutes, onSave }: {
  club: Club; court: Court; time: string; busy: boolean; defaultMinutes: number | null;
  onSave: (name: string, phone: string, slots: number, asBlock: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // a block's reason is its own field: switching modes never turns a customer's name into a reason
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState(false);
  const [hints, setHints] = useState<Guest[]>([]);
  // bookings get the club's minimum to maximum; a block has its own lengths (see durations.ts)
  const [asBlock, setAsBlock] = useState(false);
  const startMin = toMin(time);
  const closeMin = closeMinutes(club);
  const bookOpts = bookingSlotOptions(club, startMin, closeMin);
  const blockOpts = blockSlotOptions(club, startMin, closeMin);
  const opts = asBlock ? blockOpts : bookOpts;
  const wanted = Math.max(1, Math.round((defaultMinutes ?? club.min_booking_minutes) / club.slot_minutes));
  const [wish, setWish] = useState(wanted);
  const slots = pickSlots(opts, wish, Math.round(club.min_booking_minutes / club.slot_minutes));

  // customers this club has booked before, matched on what the desk has typed so far
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (picked || name.trim().length < 2) { if (alive) setHints([]); return; }
      const { data } = await createClient().rpc("club_recent_guests", { p_club: club.id, p_query: name.trim() });
      if (alive) setHints(((data as Guest[] | null) ?? []).slice(0, 5));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [name, picked, club.id]);

  const endTime = (n: number) => {
    const m = toMin(time) + n * club.slot_minutes;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => {
      e.preventDefault();
      if (slots === null) return;
      if (asBlock) onSave(reason.trim(), "", slots, true);
      else onSave(name.trim(), phone.trim(), slots, false);
    }}>
      <h2 className="text-lg font-semibold">{court.name}, {time}{slots !== null ? `–${endTime(slots)}` : ""}{asBlock ? " · block" : ""}</h2>
      {asBlock ? (
        <input key="reason" className={input} placeholder="Reason (optional)" aria-label="Block reason" value={reason} autoFocus
               onChange={(e) => setReason(e.target.value)} />
      ) : (
        <input key="name" className={input} placeholder="Name" aria-label="Customer name" required value={name} autoFocus
               onChange={(e) => { setName(e.target.value); setPicked(false); }} />
      )}
      {!asBlock && hints.length > 0 && (
        <ul className="-mt-1 divide-y divide-grid rounded-xl border border-grid bg-paper text-sm">
          {hints.map((g) => (
            <li key={`${g.name}|${g.phone ?? ""}`}>
              {/* a suggestion fills this customer's own phone, or clears it when they have none */}
              <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left"
                      onClick={() => { setName(g.name); setPhone(g.phone ?? ""); setPicked(true); setHints([]); }}>
                <span className="truncate">{g.name}</span>
                <span className="ml-3 shrink-0 text-muted">{g.phone ?? "no phone"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!asBlock && <input className={input} placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
      {opts.length > 0 ? (
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={asBlock ? "Block length" : "Booking length"}>
          {opts.map((n) => (
            <button type="button" key={n} role="radio" aria-checked={slots === n} onClick={() => setWish(n)}
                    className={`rounded-xl border py-2 text-sm ${slots === n ? "border-ink bg-ink text-white" : "border-grid"}`}>
              {fmtDur(n * club.slot_minutes)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">
          {asBlock
            ? "Not enough time before closing for a block."
            : `Not enough time before closing for a booking. Bookings here: ${fmtDur(club.min_booking_minutes)} to ${fmtDur(club.max_booking_minutes)}.`}
        </p>
      )}
      {!asBlock && opts.length > 0 && (
        <p className="-mt-1 text-xs text-muted">Bookings at this club: {fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)}.</p>
      )}
      <button type="submit" disabled={busy || slots === null} className={primary}>{busy ? "Saving…" : asBlock ? "Block this time" : "Add booking"}</button>
      {asBlock
        ? <button type="button" disabled={busy} onClick={() => setAsBlock(false)} className={backLink}>Back to booking</button>
        : <button type="button" disabled={busy} onClick={() => setAsBlock(true)} className={secondary}>Block this time instead</button>}
    </form>
  );
}

function BookingSheet({ club, courts, booking: b, times, busy, onMove, onCancel, onNoShow }: {
  club: Club; courts: Court[]; booking: Booking; times: string[]; busy: boolean;
  onMove: (courtId: string, time: string, slots: number) => void;
  onCancel: (clubCaused: boolean) => void;
  onNoShow: () => void;
}) {
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [courtId, setCourtId] = useState(b.court_id!);
  const [time, setTime] = useState(hhmm(b.start_at, club.timezone));
  const curSlots = Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60000 / club.slot_minutes);
  const [wish, setWish] = useState(curSlots);
  const [clubCaused, setClubCaused] = useState(false);
  const [started] = useState(() => new Date(b.start_at).getTime() <= Date.now());
  const court = courts.find((c) => c.id === b.court_id);
  const closeMin = closeMinutes(club);
  // the club's minimum to maximum, plus the booking's current length (always allowed to keep)
  const moveOpts = bookingSlotOptions(club, toMin(time), closeMin, curSlots);
  const slots = pickSlots(moveOpts, wish, curSlots);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{b.guest_name ?? b.player_name ?? "Player"}</h2>
        <p className="text-sm text-muted">
          {court?.name}, {formatInTimeZone(clubLocalToUtc(bookingDate(b.start_at, club.timezone), "12:00", club.timezone), club.timezone, "EEE d MMM")}, {hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)} · {b.status === "pending" ? "booked in the app, still paying" : b.source === "app" ? "booked in the app" : "desk booking"}
        </p>
        {(b.contact_phone ?? b.guest_phone)
          ? <a href={`tel:${b.contact_phone ?? b.guest_phone}`} className="text-sm text-action underline">{b.contact_phone ?? b.guest_phone}</a>
          : <p className="text-sm text-muted">No phone number on file</p>}
        {b.price_usd != null && (
          <p className="mt-1 text-sm">
            ${Number(b.price_usd).toFixed(2)}
            <span className="text-muted">
              {b.status === "pending"
                ? ` + $${Number(b.fee_usd ?? 0).toFixed(2)} fee · awaiting payment`
                : b.source === "app"
                  ? ` + $${Number(b.fee_usd ?? 0).toFixed(2)} fee · paid in the app`
                  : " · take payment at the desk, not through CourtBook"}
            </span>
          </p>
        )}
      </div>

      {mode === "view" && (
        <>
          <button disabled={busy} onClick={() => setMode("move")} className={secondary}>Move</button>
          {started && <button disabled={busy} onClick={onNoShow} className={secondary}>Mark no-show</button>}
          <button disabled={busy} onClick={() => setMode("cancel")} className={secondaryDanger}>Cancel booking</button>
        </>
      )}

      {mode === "move" && (
        <>
          <label className="flex items-center justify-between text-sm">Court
            <select className={select} value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between text-sm">Start
            <select className={select} value={time} onChange={(e) => setTime(e.target.value)}>
              {times.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between text-sm">Duration
            {moveOpts.length > 0 ? (
              <select className={select} value={slots ?? ""} onChange={(e) => setWish(Number(e.target.value))}>
                {moveOpts.map((n) => (
                  <option key={n} value={n}>{fmtDur(n * club.slot_minutes)}{n === curSlots ? " (current)" : ""}</option>
                ))}
              </select>
            ) : (
              <span className="text-muted">too close to closing</span>
            )}
          </label>
          <button disabled={busy || slots === null} onClick={() => slots !== null && onMove(courtId, time, slots)} className={primary}>{busy ? "Saving…" : "Save move"}</button>
          <button disabled={busy} onClick={() => setMode("view")} className={backLink}>Back</button>
        </>
      )}

      {mode === "cancel" && (
        <>
          {b.source === "app" && b.credit_tx_id && (
            <label className="flex items-start gap-3 rounded-xl bg-paper p-3 text-sm">
              <input type="checkbox" checked={clubCaused} onChange={(e) => setClubCaused(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>Club-caused (rain, maintenance, our mistake): refund the player&apos;s credit even inside the {club.cancel_cutoff_hours}-hour cutoff.</span>
            </label>
          )}
          <button disabled={busy} onClick={() => onCancel(clubCaused)} className="rounded-xl bg-danger py-3.5 font-medium text-white disabled:opacity-50">{busy ? "Cancelling…" : "Confirm cancellation"}</button>
          <button disabled={busy} onClick={() => setMode("view")} className={backLink}>Back</button>
        </>
      )}
    </div>
  );
}

function CloseSheet({ club, times, busy, onClose }: { club: Club; times: string[]; busy: boolean; onClose: (from: string, to: string, reason: string) => void }) {
  const closeT = club.close_time.startsWith("24:") ? "24:00" : club.close_time.slice(0, 5);
  const [from, setFrom] = useState(times[0]);
  const [to, setTo] = useState(closeT);
  const [reason, setReason] = useState("");
  const ends = [...times.slice(1), closeT];
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onClose(from, to, reason.trim()); }}>
      <h2 className="text-lg font-semibold">Close all courts</h2>
      <p className="text-sm text-muted">Blocks every court for this range. If any booking exists in it, nothing is closed; cancel or move those bookings first.</p>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">From
          <select className={select} value={from} onChange={(e) => setFrom(e.target.value)}>{times.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">To
          <select className={select} value={to} onChange={(e) => setTo(e.target.value)}>{ends.filter((t) => toMin(t) > toMin(from)).map((t) => <option key={t}>{t}</option>)}</select>
        </label>
      </div>
      <input className={input} placeholder="Reason (holiday, tournament…)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" disabled={busy} className="rounded-xl bg-danger py-3.5 font-medium text-white disabled:opacity-50">{busy ? "Closing…" : "Close courts"}</button>
    </form>
  );
}
