"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { bookingDate, clubLocalToUtc, dayBounds, hhmm, moveTarget, nextDayStart, nowMs, shiftDate, slotTimes, todayIn, toMin, weekStart } from "@/lib/time";
import { explainBookingError } from "@/lib/report";
import { blockErrorText, friendlyError, settlement, SETTLEMENT_TEXT, STAFF_BOOKING_COLUMNS, type Block, type Booking, type Club, type Court } from "@/lib/types";
import { blockEndOptions, blockStartOptions, bookingSlotOptions, minToHhmm, pickSlots, type Busy } from "./durations";
import { DESKTOP_QUERY, useDialog, useIsDesktop } from "@/components/useDialog";
import { matchBookings, readPrefs, writePrefs } from "./findBooking";
import { paymentsByBooking } from "@/lib/staffPayments";
import { isNetworkFailure } from "@/lib/actionError";
import { DESK_UNCONFIRMED, DESK_UNREACHABLE, deskStateShown, landed, type Reader } from "./landed";

type Props = { club: Club; courts: Court[]; bookings: Booking[]; blocks: Block[]; date: string; view: StaffView; sport: string | null; court: string | null; loadFailed?: boolean; sportNames: Record<string, string>;
  /** the address named a view or sport (then it is used as is, and remembered on desktop) */
  explicit?: boolean;
  /** Courts view: the time to show and focus on arrival (from the All courts week, Phase I-2c) */
  focusTime?: string | null };

export type StaffView = "now" | "grid" | "week" | "list";
/** One active court's state at this moment: busy by a booking, an unexpired hold or a block.
 *  free_at follows the chain of back-to-back bookings and blocks to when the court is really free. */
type FreeNow = { court_id: string; court_name: string; sport: string; busy: boolean; free_at: string | null };
/** All courts week (Phase I-2c): only what decides whether a court is taken. No names, no phones. */
type Taken = { court_id: string; start_at: string; end_at: string; status?: string; hold_expires_at?: string | null };
/** A past customer of this club. Name and phone only — never a player account. */
type Guest = { name: string; phone: string | null; last_at: string };

type Sheet =
  | { kind: "add"; courtId: string; time: string; date?: string }
  | { kind: "booking"; booking: Booking }
  | { kind: "block"; block: Block }
  | { kind: "close" }
  | null;
/** The sheet's name: announced to screen readers, and shown as the desktop side panel's title. */
function sheetTitle(s: NonNullable<Sheet>): string {
  return s.kind === "add" ? "Add a booking" : s.kind === "booking" ? "Booking" : s.kind === "block" ? "Blocked time" : "Close courts";
}


/** Staff see who booked and how to reach them: the desk's whole job is ringing people.
 *  Scoped in the database to staff of this club and bookings at this club. A failed read returns null, so the
 *  caller treats the refresh as failed and keeps what it had, rather than showing bookings without names (W1). */
async function withContacts(
  supabase: ReturnType<typeof createClient>,
  clubId: string,
  rows: Record<string, unknown>[],
): Promise<Booking[] | null> {
  const ids = rows.map((r) => r.id as string);
  if (!ids.length) return [] as Booking[];
  const { data, error } = await supabase.rpc("club_booking_contacts", { p_club: clubId, p_bookings: ids });
  if (error) return null;
  const by = new Map((data as { booking_id: string; name: string | null; phone: string | null }[] | null ?? [])
    .map((c) => [c.booking_id, c] as const));
  const out = rows.map((r) => ({
    ...r,
    player_name: by.get(r.id as string)?.name ?? null,
    contact_phone: by.get(r.id as string)?.phone ?? null,
  })) as unknown as Booking[];
  // the payment of each app booking (a failed read leaves it unknown, never "paid")
  return paymentsByBooking(supabase as never, out);
}

export default function DayCalendar({ club, courts: allCourts, bookings: initialBookings, blocks: initialBlocks, date, view, sport, court: courtParam, loadFailed, sportNames, explicit = false, focusTime = null }: Props) {
  // multi-sport clubs get a sport filter; single-sport clubs never see it
  const sports = [...new Set(allCourts.map((c) => c.sport))];
  const courts = sport && sports.includes(sport) ? allCourts.filter((c) => c.sport === sport) : allCourts;
  const [bookings, setBookings] = useState(initialBookings);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  // Phones and tablets: the sheet is a modal bottom sheet, as before. Desktop (≥ 1024 px): a side panel
  // beside the calendar that does not block it (Phase I-2a), with the Now summary when nothing is open.
  const isDesktop = useIsDesktop();
  // Typed but unsaved booking details: switching slot, changing day or closing the panel asks first.
  const addDirty = useRef(false);
  // phones (S1): the court names live in the sticky header and follow the grid's sideways scroll
  const namesRef = useRef<HTMLDivElement>(null);
  const confirmDiscard = useCallback(() =>
    !addDirty.current || window.confirm("Discard the details you have entered?"), []);
  // What the open add form has chosen, drawn on the grid as "Not saved" until the database has saved it.
  const [draft, setDraft] = useState<Selection | null>(null);
  // A save succeeded and the calendar has not shown a fresh read since (see run()).
  const [savedUnseen, setSavedUnseen] = useState(false);
  // R1: after an unconfirmed desk action, what the calendar now shows (never "saved" for this request)
  const [notice, setNotice] = useState<string | null>(null);
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  /** Opens a sheet, unless saving is in progress or the desk keeps its unsaved details. True if it opened. */
  const openSheet = useCallback((next: Sheet) => {
    if (busy) return false;
    if (!confirmDiscard()) return false;
    addDirty.current = false;
    setError(null);
    setSheet(next);
    return true;
  }, [busy, confirmDiscard]);
  // Keyboard and focus (Phase I-2b): where focus goes back to when the panel closes, and the item just saved.
  const returnTo = useRef<{ kind: "cell"; courtId: string; row: number } | { kind: "week"; day: string; time: string } | { kind: "search" } | null>(null);
  const savedFocus = useRef<{ courtId: string; day: string; time: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const weekRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // arriving from the All courts week: start on that time (first court)
  const [cell, setCell] = useState<{ c: number; r: number } | null>(() => {
    if (view !== "grid" || !focusTime) return null;
    const r = (toMin(focusTime) - toMin(club.open_time)) / club.slot_minutes;
    return Number.isInteger(r) && r >= 0 ? { c: 0, r } : null;
  });
  const focusCellNext = useRef(false);
  const [find, setFind] = useState("");
  // the booking or block whose details are shown, and the row they are shown beside (pointer or keyboard)
  const [peek, setPeek] = useState<{ id: string; row: number } | null>(null);
  const closeSheet = useCallback(() => openSheet(null), [openSheet]);
  const dialogRef = useDialog<HTMLDivElement>(!!sheet, closeSheet, { canClose: !busy, modal: !isDesktop });
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const weekQuiet = useRef(false);
  const [nowMin, setNowMin] = useState<number | null>(null);
  const [freeNow, setFreeNow] = useState<FreeNow[] | null>(null);
  const [showLater, setShowLater] = useState(false);
  const [commonMins, setCommonMins] = useState<number | null>(null);
  const [week, setWeek] = useState<{ key: string; bookings: Booking[]; blocks: Block[] } | null>(null);
  const [avail, setAvail] = useState<{ key: string; bookings: Taken[]; blocks: Taken[] } | null>(null);
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

  // week view shows one court at a time: seven columns is all a phone has room for. Desktop also has
  // "All courts" (Phase I-2c): how many courts of the shown sport are free at each time.
  const weekAll = view === "week" && courtParam === "all" && isDesktop;
  const weekCourt = weekAll ? null : courts.find((c) => c.id === courtParam) ?? courts[0] ?? null;
  const courtKey = courts.map((c) => c.id).join(",");
  const wkStart = weekStart(date);
  const weekDays = Array.from({ length: 7 }, (_, i) => shiftDate(wkStart, i));
  // Entering All courts, or another week or set of courts there, starts with nothing: counts kept from an earlier
  // visit are dropped while rendering, so not even the first frame shows unverified counts (review). Only a read
  // made for this visit fills them (a quiet automatic refresh within the visit keeps them, as the day view does).
  const allKey = weekAll ? `${wkStart}|all|${courtKey}` : null;
  const [allVisit, setAllVisit] = useState<string | null>(null);
  if (allKey !== allVisit) {
    setAllVisit(allKey);
    if (allKey) setAvail(null);
  }

  // the sport filter must narrow the bookings too, not just which courts are drawn
  const shownCourtIds = new Set(courts.map((c) => c.id));
  const shownBookings = bookings.filter((b) => b.court_id && shownCourtIds.has(b.court_id));
  const shownBlocks = blocks.filter((k) => shownCourtIds.has(k.court_id));
  // List and Print (Phase I-2c): bookings and blocks of the shown courts, in time order, then court order
  const courtOrder = new Map(courts.map((c, i) => [c.id, i] as const));
  const listRows = [
    ...shownBookings.map((b) => ({ kind: "booking" as const, b, at: b.start_at, court: b.court_id! })),
    ...shownBlocks.map((k) => ({ kind: "block" as const, k, at: k.start_at, court: k.court_id })),
  ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at) || (courtOrder.get(x.court) ?? 0) - (courtOrder.get(y.court) ?? 0));

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
  // `quiet` (the automatic refresh): the rows on screen stay usable while it runs, because they were
  // just as current a moment ago; only a failure marks them as possibly outdated.
  const reload = useCallback(async (quiet = false) => {
    const seq = ++dayReq.current;
    if (!quiet) setDayLoading(true);
    const supabase = createClient();
    const { dayStart, dayEnd } = dayBounds(date, club.timezone);
    const [{ data: b, error: eb }, { data: k, error: ek }] = await Promise.all([
      supabase.from("bookings").select(STAFF_BOOKING_COLUMNS)
        .eq("club_id", club.id).or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`).not("court_id", "is", null).lt("start_at", dayEnd).gt("end_at", dayStart).order("start_at"),
      supabase.from("blocks").select("id, court_id, start_at, end_at, reason").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
    ]);
    if (seq !== dayReq.current) return;                                  // a newer read owns the state now
    if (eb || ek) { setDayError(true); setDayLoading(false); return; }   // keep what we had rather than showing free slots
    const rows = await withContacts(supabase, club.id, b ?? []);
    if (seq !== dayReq.current) return;                                  // and again, after the second await
    if (!rows) { setDayError(true); setDayLoading(false); return; }
    setBookings(rows);
    setBlocks((k ?? []) as Block[]);
    setDayError(false);
    setDayLoading(false);
    if (viewRef.current !== "week") setSavedUnseen(false);
    setLastUpdated(formatInTimeZone(new Date(), club.timezone, "HH:mm"));
  }, [club.id, club.timezone, date]);

  // Automatic refresh (Phase I-2a): every 60 s while the page is visible, and on returning to it.
  // It re-runs the reads the page already makes and changes nothing else: the open panel, the typed
  // details and the date stay as they are; an older answer never replaces a newer one (dayReq, and
  // the week effect's `alive`); a failed read shows the "may be out of date" banner and keeps adding
  // off until a read succeeds. Now view and the desktop panel also refresh which courts are free now.
  // The server decides what "busy" means (booking, unexpired hold or block).
  useEffect(() => {
    const wantsFree = view === "now" || (isDesktop && isToday);
    let alive = true;
    const loadFree = async () => {
      if (!wantsFree) return;
      const { data } = await createClient().rpc("club_courts_free_now", { p_club: club.id });
      if (alive && data) setFreeNow(data as FreeNow[]);
    };
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (view === "week") { weekQuiet.current = true; setRefresh((n) => n + 1); }
      else await reload(true);
      await loadFree();
    };
    if (view === "now") void (async () => { await loadFree(); if (alive) await reload(); })();
    else void loadFree();
    const id = setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [view, isDesktop, isToday, club.id, reload]);

  // week view: one query for the whole week, keyed so a stale answer can never be shown
  useEffect(() => {
    if (view !== "week" || !weekCourt) return;
    // an All courts address on a desktop: the first render does not know the width yet; skip the court read
    if (courtParam === "all" && typeof window.matchMedia === "function" && window.matchMedia(DESKTOP_QUERY).matches) return;
    const key = `${wkStart}|${weekCourt.id}`;
    let alive = true;
    const quiet = weekQuiet.current;
    weekQuiet.current = false;
    (async () => {
      if (!quiet) setWeekLoading(true);
      const supabase = createClient();
      const from = dayBounds(wkStart, club.timezone).dayStart;
      const to = dayBounds(shiftDate(wkStart, 6), club.timezone).dayEnd;
      const [{ data: b, error: eb }, { data: k, error: ek }] = await Promise.all([
        supabase.from("bookings").select(STAFF_BOOKING_COLUMNS)
          .eq("club_id", club.id).eq("court_id", weekCourt.id)
          .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`)
          .lt("start_at", to).gt("end_at", from).order("start_at"),
        supabase.from("blocks").select("id, court_id, start_at, end_at, reason")
          .eq("club_id", club.id).eq("court_id", weekCourt.id).lt("start_at", to).gt("end_at", from),
      ]);
      if (eb || ek) { if (alive) { setWeekError(true); setWeekLoading(false); } return; }
      const rows = await withContacts(supabase, club.id, b ?? []);
      if (!alive) return;
      if (!rows) { setWeekError(true); setWeekLoading(false); return; }
      setWeek({ key, bookings: rows, blocks: (k ?? []) as Block[] });
      setWeekError(false);
      setWeekLoading(false);
      setSavedUnseen(false);
      setLastUpdated(formatInTimeZone(new Date(), club.timezone, "HH:mm"));
    })();
    return () => { alive = false; };
  }, [view, club.id, club.timezone, wkStart, weekCourt, courtParam, refresh]);

  // All courts week (Phase I-2c): one read of what is taken on the shown courts for the week — confirmed
  // bookings, unexpired holds and blocks; start and end only, no names or phones. Keyed like the week above.
  useEffect(() => {
    if (!weekAll || !courtKey) return;
    const key = `${wkStart}|all|${courtKey}`;
    let alive = true;
    const quiet = weekQuiet.current;
    weekQuiet.current = false;
    (async () => {
      if (!quiet) setWeekLoading(true);
      const supabase = createClient();
      const from = dayBounds(wkStart, club.timezone).dayStart;
      const to = dayBounds(shiftDate(wkStart, 6), club.timezone).dayEnd;
      const ids = courtKey.split(",");
      const [{ data: b, error: eb }, { data: k, error: ek }] = await Promise.all([
        supabase.from("bookings").select("court_id, start_at, end_at, status, hold_expires_at")
          .eq("club_id", club.id).in("court_id", ids)
          .or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`)
          .lt("start_at", to).gt("end_at", from),
        supabase.from("blocks").select("court_id, start_at, end_at")
          .eq("club_id", club.id).in("court_id", ids).lt("start_at", to).gt("end_at", from),
      ]);
      if (!alive) return;
      if (eb || ek) { setWeekError(true); setWeekLoading(false); return; }
      setAvail({ key, bookings: (b ?? []) as Taken[], blocks: (k ?? []) as Taken[] });
      setWeekError(false);
      setWeekLoading(false);
      setLastUpdated(formatInTimeZone(new Date(), club.timezone, "HH:mm"));
    })();
    return () => { alive = false; };
  }, [weekAll, courtKey, club.id, club.timezone, wkStart, refresh]);

  // the duration this club books most often, so the walk-in sheet opens on it
  useEffect(() => {
    let alive = true;
    createClient().rpc("club_common_duration", { p_club: club.id }).then(({ data }) => {
      if (alive && typeof data === "number") setCommonMins(data);
    });
    return () => { alive = false; };
  }, [club.id]);

  async function run(
    fn: () => PromiseLike<{ error: { message: string; code?: string } | null }>,
    explain: (m: string) => string = friendlyError,
    check?: { find: (db: Reader) => Promise<boolean | null>; shows: string },
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error } = await fn();
    if (error) {
      // R1: the grid is read again first, so it shows what is actually saved; then the action's result is looked for.
      await reload();
      setRefresh((n) => n + 1);   // the week view holds its own copy of the rows
      const found = check ? await check.find(createClient() as unknown as Reader).catch(() => null) : undefined;
      setBusy(false);
      savedFocus.current = null;
      if (found === true && check) {
        // A matching result is there, but it may be another staff member's doing the same thing (Paul's review,
        // correction A): close the sheet so the grid shows it, and say what the calendar shows — never "saved".
        addDirty.current = false;
        setSheet(null);
        setNotice(deskStateShown(check.shows));
        return;
      }
      if (isNetworkFailure(error.message)) setError(found === null ? DESK_UNREACHABLE : DESK_UNCONFIRMED);   // correction B: never "not saved"
      else setError(explainBookingError(error.message, error.code, explain(error.message)));   // reports only the unexpected
      return;
    }
    await saved();
  }
  async function saved() {
    // Saved. The write is never repeated: if the reads below fail, the banner says the calendar may be
    // out of date and that this was saved, and adding stays off until a read succeeds.
    setSavedUnseen(true);
    await reload();
    setRefresh((n) => n + 1);   // the week view holds its own copy of the rows
    setBusy(false);
    addDirty.current = false;
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

  /** Minutes after club midnight of `iso` as seen on `day`: 0 before that day, 1440 after it. */
  function minutesOn(iso: string, day: string) {
    const d = formatInTimeZone(parseISO(iso), club.timezone, "yyyy-MM-dd");
    return d < day ? 0 : d > day ? 24 * 60 : toMin(hhmm(iso, club.timezone));
  }
  /** What the calendar's rows say is taken on one court and day: bookings, unexpired holds and blocks. */
  function takenOn(courtId: string, day: string): Busy[] {
    const src = view === "week" ? week ?? { bookings: [], blocks: [] } : { bookings, blocks };
    const rows = [...src.bookings.filter((b) => b.court_id === courtId), ...src.blocks.filter((k) => k.court_id === courtId)];
    return rows.map((r) => [minutesOn(r.start_at, day), minutesOn(r.end_at, day)] as const).filter(([a, b]) => b > a && b > 0 && a < 24 * 60);
  }
  /** Minutes before which every slot of `day` has ended: today the current minute, a past day all of it. */
  function endedBefore(day: string) {
    const today = todayIn(club.timezone);
    return day < today ? 24 * 60 : day > today ? -1 : toMin(formatInTimeZone(new Date(nowMs()), club.timezone, "HH:mm"));
  }
  /** The open add form's choice on this court and day, if any (for the "Not saved" highlight). */
  const draftOn = (courtId: string, day: string) =>
    sheet?.kind === "add" && draft && sheet.courtId === courtId && (sheet.date ?? date) === day ? draft : null;

  // ---- Keyboard grid (Phase I-2b) ------------------------------------------------------------------------
  // The Courts grid is one Tab stop. Inside it ↑/↓ move between times, ←/→ between courts, Home/End to opening
  // and closing; Enter (the button's own key) opens the free slot, booking or block. A time covered by a
  // booking or block is that booking or block: its "Add booking" button underneath is disabled and hidden from
  // the keyboard and screen readers (the database refused a booking there anyway).
  type GridItem = { kind: "booking"; b: Booking; row: number; end: number } | { kind: "block"; k: Block; row: number; end: number };
  const gridItems: Record<string, GridItem[]> = {};
  for (const c of courts) gridItems[c.id] = [];
  for (const k of blocks) if (gridItems[k.court_id]) { const p = place(k.start_at, k.end_at); gridItems[k.court_id].push({ kind: "block", k, row: p.row, end: p.row + p.span }); }
  for (const b of bookings) if (b.court_id && gridItems[b.court_id]) { const p = place(b.start_at, b.end_at); gridItems[b.court_id].push({ kind: "booking", b, row: p.row, end: p.row + p.span }); }
  const itemAt = (courtId: string, row: number) => gridItems[courtId]?.find((it) => it.row <= row && it.end > row) ?? null;
  const itemKey = (it: GridItem) => (it.kind === "booking" ? it.b.id : it.k.id);
  const firstRow = isToday && nowMin !== null ? Math.min(times.length - 1, Math.max(0, Math.floor((nowMin - openMin) / club.slot_minutes))) : 0;
  const active = { c: Math.min(cell?.c ?? 0, Math.max(0, courts.length - 1)), r: Math.min(cell?.r ?? firstRow, Math.max(0, times.length - 1)) };
  const activeItem = courts[active.c] ? itemAt(courts[active.c].id, active.r) : null;
  /** The element that stands for a cell: its booking or block, else its free slot (null if disabled). */
  function cellElement(courtId: string, row: number): HTMLElement | null {
    const root = gridRef.current;
    if (!root) return null;
    const it = itemAt(courtId, row);
    const el = root.querySelector<HTMLButtonElement>(it ? `[data-item="${itemKey(it)}"]` : `[data-cell="${courtId}:${row}"]`);
    return el && !el.disabled ? el : null;
  }
  function onGridKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.closest("[data-cell],[data-item]")) return;
    e.preventDefault();
    let { c, r } = active;
    const cur = courts[c] ? itemAt(courts[c].id, r) : null;
    if (e.key === "ArrowLeft") c = Math.max(0, c - 1);
    else if (e.key === "ArrowRight") c = Math.min(courts.length - 1, c + 1);
    else if (e.key === "ArrowDown") r = Math.min(times.length - 1, cur ? cur.end : r + 1);
    else if (e.key === "ArrowUp") r = Math.max(0, cur ? cur.row - 1 : r - 1);
    else if (e.key === "Home") r = 0;
    else r = times.length - 1;
    focusCellNext.current = true;
    setCell({ c, r });
  }
  useEffect(() => {
    if (!focusCellNext.current) return;
    focusCellNext.current = false;
    const c = courts[active.c];
    if (c) cellElement(c.id, active.r)?.focus();
  });

  // Where focus goes when the panel closes: the booking or block just saved (once the calendar has re-read it),
  // else the cell or search box it was opened from, else the calendar itself. Never somewhere unrelated.
  const prevSheet = useRef<Sheet>(null);
  useEffect(() => {
    const was = prevSheet.current;
    prevSheet.current = sheet;
    if (!was || sheet) return;
    const saved = savedFocus.current, ret = returnTo.current;
    savedFocus.current = null;
    returnTo.current = null;
    if (!saved && !ret) return;
    let el: HTMLElement | null = null;
    if (view === "week") {
      const at = saved ?? (ret?.kind === "week" ? { day: ret.day, time: ret.time } : null);
      if (at) el = weekRef.current?.querySelector<HTMLButtonElement>(`[data-week-cell="${at.day}|${at.time}"]:not([disabled])`) ?? null;
      if (!el && ret?.kind === "week") el = weekRef.current;
    } else {
      const target = saved && saved.day === date ? { courtId: saved.courtId, row: (toMin(saved.time) - openMin) / club.slot_minutes }
        : ret?.kind === "cell" ? ret : null;
      if (target) {
        el = cellElement(target.courtId, target.row);
        const ci = courts.findIndex((c) => c.id === target.courtId);
        if (ci >= 0) setCell({ c: ci, r: target.row });
      }
      if (!el && ret?.kind === "search") el = searchRef.current;
      if (!el && (target || ret)) el = gridRef.current;
    }
    el?.focus();
  }, [sheet]);   // eslint-disable-line react-hooks/exhaustive-deps -- only when the panel opens or closes

  // Arriving from the All courts week (Phase I-2c): show that time and put the keyboard on it (first court). The
  // calendar stays mounted when only the view changes (same day), so this follows the address: a new arrival is
  // noticed while rendering (React's "adjust state when a prop changes"), then focused once after it is drawn.
  const arrivalKey = view === "grid" && focusTime ? `${date}|${focusTime}` : null;
  const arrivalRow = (t: string | null) => {
    if (!t) return null;
    const r = (toMin(t) - openMin) / club.slot_minutes;
    return Number.isInteger(r) && r >= 0 && r < times.length ? r : null;
  };
  const [arrival, setArrival] = useState(() => ({ key: arrivalKey, row: arrivalKey ? arrivalRow(focusTime) : null }));
  if (arrival.key !== arrivalKey) {
    const r = arrivalKey ? arrivalRow(focusTime) : null;
    setArrival({ key: arrivalKey, row: r });
  }
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    if (arrival.row === null || !arrival.key || arrived.current === arrival.key || !courts[0]) return;
    arrived.current = arrival.key;
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${courts[0].id}:${arrival.row}"]`)?.scrollIntoView?.({ block: "center" });
    (cellElement(courts[0].id, arrival.row) ?? gridRef.current)?.focus({ preventScroll: true });
  }, [arrival]);   // eslint-disable-line react-hooks/exhaustive-deps -- once per arrival

  // Find a booking (Phase I-2b): only the bookings of this day already on screen; never a new read.
  const found = view === "grid" || view === "list" ? matchBookings(shownBookings, find) : [];
  const foundIds = new Set(found.map((b) => b.id));


  // only the view being looked at decides whether its rows can be trusted
  const viewError = view === "week" ? weekError : dayError;
  const viewLoading = view === "week" ? weekLoading : dayLoading;
  const canAdd = !viewError && !viewLoading;

  const q = (d: string, v: string, sp: string | null, ct?: string | null) =>
    `/staff/${club.slug}?date=${d}&view=${v}${sp ? `&sport=${sp}` : ""}${ct ? `&court=${ct}` : ""}`;
  const nav = (d: string) => q(d, view, sport, view === "week" ? (weekAll ? "all" : weekCourt?.id) : null);

  // Remembered view and sport filter (desktop only, this browser). An address that names a view or sport wins
  // and is remembered; a plain address opens on what was used last.
  useEffect(() => {
    if (!isDesktop) return;
    if (explicit) { writePrefs(club.slug, { view, sport }); return; }
    const p = readPrefs(club.slug);
    if (!p) return;
    const v = p.view === "now" && !isToday ? "grid" : p.view;
    const sp = p.sport && sports.includes(p.sport) ? p.sport : null;
    if (v !== view || sp !== sport) router.replace(q(v === "now" ? todayIn(club.timezone) : date, v, sp, v === "week" ? courtParam : null));
  }, [isDesktop, explicit, view, sport]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving the day (any link: ‹ ›, Today, a view, a sport, the staff bar) with typed booking details
  // asks first, like switching slots.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!addDirty.current || e.defaultPrevented) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && !confirmDiscard()) { e.preventDefault(); e.stopPropagation(); }
      else if (a) addDirty.current = false;
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [confirmDiscard]);

  // Keyboard (Phase I-2a): ← / → previous / next day (or week), T today — only when no control has
  // focus (so never while typing, in the customer search, the date field, the panel, a length choice or
  // on a focused slot or link), never with a modifier key, never while saving. Enter is never a
  // shortcut: on a slot it only opens the add form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || busy) return;
      // only when no control has keyboard focus (focus on the page itself): a focused button, link, field,
      // date, length choice, panel or slot keeps its own arrow keys
      const el = e.target instanceof Element ? e.target : null;
      if (el && el !== document.body && el !== document.documentElement) return;
      const step = view === "week" ? 7 : 1;
      const to = e.key === "ArrowLeft" ? shiftDate(date, -step) : e.key === "ArrowRight" ? shiftDate(date, step)
        : e.key === "t" || e.key === "T" ? todayIn(club.timezone) : null;
      if (!to || to === date) return;
      e.preventDefault();
      if (!confirmDiscard()) return;
      addDirty.current = false;
      router.push(nav(to));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  const dayNum = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "d");
  const dayName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "EEEE");
  const monthName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "MMMM yyyy");
  const courtName = (id: string | null) => courts.find((c) => c.id === id)?.name ?? "";

  // any court of the club, including one the sport filter hides (a move can go to another sport's court)
  const anyCourtName = (id: string | null) => allCourts.find((c) => c.id === id)?.name ?? "the court";


  /** What a sheet holds — the same on phones (bottom sheet) and desktop (side panel). */
  function sheetBody(sheet: NonNullable<Sheet>) {
    return (
      <>

            {sheet.kind === "add" && (
              <AddSheet
                key={`${sheet.courtId}|${sheet.date ?? date}|${sheet.time}`}
                onDirty={(d) => { addDirty.current = d; }}
                club={club} court={courts.find((c) => c.id === sheet.courtId)!} time={sheet.time} busy={busy}
                defaultMinutes={commonMins}
                taken={takenOn(sheet.courtId, sheet.date ?? date)}
                endedBefore={endedBefore(sheet.date ?? date)}
                onSelection={setDraft}
                onSave={(name, phone, slots, asBlock, blockStart, blockEnd) => {
                  // after the save, focus goes to what was saved (where it starts), once it is on the grid
                  savedFocus.current = { courtId: sheet.courtId, day: sheet.date ?? date, time: asBlock && blockStart ? blockStart : sheet.time };
                  // in the week view the slot belongs to the column's day, not the page's date
                  const day = sheet.date ?? date;
                  const courtId = sheet.courtId;
                  if (asBlock && blockStart && blockEnd) {
                    // a block is the wall-clock interval the desk chose (start and end selectors), so on the night the
                    // clocks go back 22:00–24:00 is 3 real hours; the database checks staff rights, the court, the grid,
                    // the hours, the past and overlaps (0076)
                    const bs = clubLocalToUtc(day, blockStart, club.timezone).toISOString();
                    const be = (blockEnd === "24:00" ? nextDayStart(day, club.timezone) : clubLocalToUtc(day, blockEnd, club.timezone)).toISOString();
                    return run(() => createClient().rpc("staff_block", { p_club: club.id, p_court: courtId, p_start: bs, p_end: be, p_reason: name || null }),
                      (m) => blockErrorText(m, club), { find: (db) => landed.block(db, courtId, bs, be), shows: `a block on ${anyCourtName(courtId)} from ${blockStart} to ${blockEnd}` });
                  }
                  const start = clubLocalToUtc(day, sheet.time, club.timezone);
                  const s0 = start.toISOString();
                  const e0 = new Date(start.getTime() + slots * club.slot_minutes * 60000).toISOString();
                  // the database checks staff rights, the court, the hours, the grid and the duration, and prices it
                  return run(() => createClient().rpc("staff_book", { p_club: club.id, p_court: courtId, p_start: s0, p_end: e0, p_name: name, p_phone: phone || null }),
                    undefined, { find: (db) => landed.walkIn(db, courtId, s0, e0, name), shows: `a booking for ${name.trim()} on ${anyCourtName(courtId)} at ${hhmm(s0, club.timezone)}` });
                }}
              />
            )}

            {sheet.kind === "booking" && (
              <BookingSheet
                key={sheet.booking.id}
                club={club} courts={allCourts} booking={sheet.booking} times={times} busy={busy}
                onMove={(courtId, time, slots, price) => {
                  // the day comes from the booking, never from the page: the sheet can be opened
                  // from a week whose URL says another day (covered by src/lib/time.test.ts)
                  const { start, end } = moveTarget(sheet.booking.start_at, club.timezone, time, slots, club.slot_minutes);
                  const id = sheet.booking.id, s0 = start.toISOString(), e0 = end.toISOString();
                  // 0091: the price the desk was shown and confirmed; the database refuses if it is no longer right
                  return run(() => createClient().rpc("move_booking_priced", { p_booking: id, p_court: courtId, p_start: s0, p_end: e0, p_expected_price: price }),
                    undefined, { find: (db) => landed.moved(db, id, courtId, s0, e0), shows: `this booking on ${anyCourtName(courtId)} at ${hhmm(s0, club.timezone)}` });
                }}
                onCancel={(clubCaused) => run(() => createClient().rpc("cancel_booking", { p_booking: sheet.booking.id, p_club_caused: clubCaused }),
                  undefined, { find: (db) => landed.status(db, sheet.booking.id, "cancelled"), shows: "this booking as cancelled" })}
                onNoShow={() => run(() => createClient().rpc("mark_no_show", { p_booking: sheet.booking.id }),
                  undefined, { find: (db) => landed.status(db, sheet.booking.id, "no_show"), shows: "this booking as a no-show" })}
              />
            )}

            {sheet.kind === "block" && (
              <div className="flex flex-col gap-3">
                <h2 className="text-lg font-semibold">{sheet.block.reason ?? "Blocked"}</h2>
                <p className="text-sm text-muted">{courtName(sheet.block.court_id)} · {hhmm(sheet.block.start_at, club.timezone)}–{hhmm(sheet.block.end_at, club.timezone)}</p>
                <button disabled={busy} onClick={() => run(() => createClient().from("blocks").delete().eq("id", sheet.block.id), undefined, { find: (db) => landed.blockGone(db, sheet.block.id), shows: "this block as removed" })} className={secondaryDanger}>Remove block</button>
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
      </>
    );
  }

  /** A court's column heading: in the grid (desktop; screen readers everywhere) and in the phone header strip (S1). */
  const courtHead = (c: Court, extra = "") => (
    <div key={c.id} className={`px-1 text-center text-sm lg:sticky lg:top-0 lg:z-10 ${draftOn(c.id, date) ? "rounded-t-lg bg-draft-soft lg:bg-draft-soft" : "lg:bg-paper"} ${extra}`}>
      <div className={`font-medium leading-tight lg:text-[15px] ${draftOn(c.id, date) ? "text-draft" : ""}`}>{c.name}</div>
      <div className="text-xs text-muted">{sportNames[c.sport] ?? c.sport}</div>
    </div>
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col lg:max-w-[1600px] lg:flex-row">
      {/* desktop: the calendar column scrolls on its own beside the panel; phones: no wrapper box */}
      <div className="contents lg:flex lg:h-[calc(100vh-4rem)] lg:min-w-0 lg:flex-1 lg:flex-col">
      <header className="sticky top-0 z-10 bg-paper/95 backdrop-blur lg:static lg:shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-3 text-sm">
          <Link href="/" className="text-muted">‹ {club.name}</Link>
          <div className="flex flex-wrap gap-x-4 gap-y-1">{/* on desktop these two are in the staff bar (WorkNav) */}<Link href={`/staff/${club.slug}/payments`} className="text-muted lg:hidden">Payments</Link><Link href={`/staff/${club.slug}/settings`} className="text-muted lg:hidden">Settings</Link><button onClick={() => openSheet({ kind: "close" })} className="text-danger">Close courts…</button></div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2 px-4 pb-3 pt-1">
          {view === "week" ? (
            <div className="leading-tight">
              <div className="text-2xl font-semibold tracking-tight">Week of {formatInTimeZone(clubLocalToUtc(wkStart, "12:00", club.timezone), club.timezone, "d MMM")}</div>
              <div className="text-sm text-muted">{weekAll ? `All ${sport ? `${sportNames[sport] ?? sport} ` : ""}courts` : weekCourt?.name ?? "No courts"}</div>
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
        {/* wraps only when the switcher and the key do not fit side by side (360-px phones; W1) */}
        <div className="flex flex-wrap items-center justify-between gap-y-2 px-4 pb-2">
          <div className="flex rounded-full border border-grid bg-white p-0.5 text-sm">
            <Link href={q(todayIn(club.timezone), "now", sport)} className={`rounded-full px-4 py-1.5 ${view === "now" ? "bg-ink text-white" : ""}`}>Now</Link>
            <Link href={q(date, "grid", sport)} className={`rounded-full px-4 py-1.5 ${view === "grid" ? "bg-ink text-white" : ""}`}>Courts</Link>
            <Link href={q(date, "week", sport, weekCourt?.id)} className={`rounded-full px-4 py-1.5 ${view === "week" ? "bg-ink text-white" : ""}`}>Week</Link>
            <Link href={q(date, "list", sport)} className={`rounded-full px-4 py-1.5 ${view === "list" ? "bg-ink text-white" : ""}`}>List</Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            {(view === "grid" || view === "list") && (
              <FindBooking
                inputRef={searchRef} value={find} onChange={setFind} results={found} courtName={courtName} tz={club.timezone}
                onOpen={(b) => { if (openSheet({ kind: "booking", booking: b })) returnTo.current = { kind: "search" }; }}
              />
            )}
            <label className="hidden items-center gap-1.5 lg:flex">
              <span className="sr-only">Go to date</span>
              <input type="date" value={date} aria-label="Go to date"
                onChange={(e) => { const d = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== date && confirmDiscard()) { addDirty.current = false; router.push(nav(d)); } }}
                className="h-9 rounded-lg border border-grid bg-white px-2 text-sm text-ink" />
            </label>
            {(view === "grid" || view === "list") && (
              <button type="button" onClick={() => window.print()}
                className="hidden h-9 items-center rounded-lg border border-grid bg-white px-3 text-sm text-ink focus-visible:outline-2 focus-visible:outline-turf lg:inline-flex">Print day</button>
            )}
            {lastUpdated && <span className="hidden lg:inline" aria-live="polite">Updated {lastUpdated}</span>}
            {/* the colour key; desktop explains every state drawn (Phase I-2c), phones keep the short key */}
            {!weekAll && (
              <span className="flex items-center gap-3 lg:text-[13px]">
                <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-turf" />app</span>
                <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-sand" />desk</span>
                <span className="hidden items-center gap-1 lg:flex"><i className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-turf bg-white" />being paid</span>
                <span className="hidden items-center gap-1 lg:flex"><i className="hatch inline-block h-2.5 w-2.5 rounded-sm border border-grid bg-slate-soft" />blocked</span>
                {view !== "list" && <span className="hidden items-center gap-1 lg:flex"><i className={`inline-block h-2.5 w-2.5 rounded-sm border border-grid ${PAST_BG}`} />past</span>}
                {sheet?.kind === "add" && <span className="hidden items-center gap-1 lg:flex"><i className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-draft bg-draft-soft" />not saved</span>}
              </span>
            )}
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
            <Link href={q(date, "week", sport, "all")} className={`hidden min-h-9 shrink-0 rounded-full border px-3 text-xs leading-9 lg:block ${weekAll ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>All courts</Link>
            {courts.map((c) => (
              <Link key={c.id} href={q(date, "week", sport, c.id)} className={`min-h-9 shrink-0 rounded-full border px-3 text-xs leading-9 ${weekCourt?.id === c.id ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{c.name}</Link>
            ))}
          </div>
        )}
        {view === "grid" && (
          // phones only: the grid scrolls with the page, so its own name row would scroll away (S1). This copy sits in
          // the sticky header; onScroll below keeps it lined up with the columns. Screen readers use the grid's row.
          <div ref={namesRef} aria-hidden="true" data-testid="court-names" className="overflow-hidden pl-0 pr-2 lg:hidden">
            <div className="flex min-w-max">
              {/* covers the names as they scroll left, like the time column below it */}
              <div className="sticky left-0 z-10 w-[3.75rem] shrink-0 bg-paper" />
              <div className="grid flex-1 gap-x-1.5 [--col-min:7rem]" style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(var(--col-min), 1fr))` }}>
                {courts.map((c) => courtHead(c, "min-h-9"))}
              </div>
            </div>
          </div>
        )}
      </header>

      {viewError && (
        <div className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-danger/40 bg-red-50 px-3 py-2 text-sm text-danger">
          <span className="flex-1">{savedUnseen ? "Saved. " : ""}Couldn&apos;t load the latest {view === "week" ? "week" : "bookings"}. What you see may be out of date, so adding is off until this works.</span>
          {/* the flag is cleared by a successful read, never by tapping Retry */}
          <button disabled={viewLoading} onClick={() => { setRefresh((n) => n + 1); void reload(); }} className="shrink-0 rounded-lg border border-danger/40 px-3 py-1 disabled:opacity-50">{viewLoading ? "Checking…" : "Retry"}</button>
        </div>
      )}

      {notice && (
        <div role="status" className="mx-4 mt-3 flex items-center gap-3 rounded-xl border border-sand bg-sand-soft px-3 py-2 text-sm">
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice(null)} className="shrink-0 rounded-lg border border-grid bg-white px-3 py-1">OK</button>
        </div>
      )}

      <div className="contents lg:block lg:min-h-0 lg:flex-1 lg:overflow-auto">
      {view === "week" && weekAll ? (
        <AllCourtsWeek
          club={club} courts={courts} days={weekDays} times={times}
          data={avail && avail.key === `${wkStart}|all|${courtKey}` && !weekError && !weekLoading ? avail : null}
          failed={weekError}
          cellHref={(d, t) => `${q(d, "grid", sport)}&time=${t}`}
          dayHref={(d) => q(d, "grid", sport)}
          rootRef={weekRef}
        />
      ) : view === "week" ? (
        <WeekGrid
          club={club} court={weekCourt} days={weekDays} times={times} today={todayIn(club.timezone)}
          data={week && week.key === `${wkStart}|${weekCourt?.id}` ? week : null}
          canAdd={canAdd}
          dayHref={(d) => q(d, "grid", sport)}
          rootRef={weekRef}
          onOpenBooking={(b, d, t) => { if (openSheet({ kind: "booking", booking: b })) returnTo.current = { kind: "week", day: d, time: t }; }}
          onOpenBlock={(bl, d, t) => { if (openSheet({ kind: "block", block: bl })) returnTo.current = { kind: "week", day: d, time: t }; }}
          onAdd={(d, t) => { if (weekCourt && openSheet({ kind: "add", courtId: weekCourt.id, time: t, date: d })) returnTo.current = { kind: "week", day: d, time: t }; }}
          draft={weekCourt && sheet?.kind === "add" && sheet.date ? (draftOn(weekCourt.id, sheet.date) ? { day: sheet.date, ...draft! } : null) : null}
        />
      ) : view === "now" ? (
        <NowPanel
          club={club} courts={courts} bookings={shownBookings} freeNow={freeNow} sportNames={sportNames}
          showLater={showLater} onToggleLater={() => setShowLater((v) => !v)}
          onOpen={(b) => openSheet({ kind: "booking", booking: b })}
        />
      ) : view === "grid" ? (
        <div className="flex-1 overflow-x-auto pb-24 pl-0 pr-2 lg:overflow-visible lg:pb-6 lg:pl-2" onScroll={(e) => { if (namesRef.current) namesRef.current.scrollLeft = e.currentTarget.scrollLeft; }}>
          <div className="flex min-w-max">
            {/* time axis: pinned on the left while the courts scroll sideways (S2); on phones it starts level with the
                first row, because the court names are in the header. z-[8]: above bookings (≤ z-[6]), below the
                sticky header (z-10) and the sheets (z-20) */}
            <div className="sticky left-0 z-[8] w-[3.75rem] shrink-0 bg-paper lg:z-20 lg:mt-9 lg:w-14" style={{ height: times.length * ROW_PX }}>
              {times.map((t, i) => i % labelEvery === 0 && (
                <div key={t} className="absolute right-1.5 -translate-y-1/2 whitespace-nowrap text-xs text-muted lg:right-2 lg:text-[13px]" style={{ top: i * ROW_PX }}>{t}</div>
              ))}
            </div>
            {/* courts: one Tab stop; arrows move inside (see onGridKey) */}
            <span id="grid-keys-hint" className="sr-only">Arrow keys move between times and courts; Enter opens the free time, booking or block.</span>
            <div ref={gridRef} role="group" aria-label={`Courts, ${dayName} ${dayNum} ${monthName}`} aria-describedby="grid-keys-hint"
                 tabIndex={activeItem || canAdd ? -1 : 0} onKeyDown={onGridKey}
                 className="grid flex-1 gap-x-1.5 outline-none [--col-min:7rem] focus-visible:ring-2 focus-visible:ring-turf lg:[--col-min:9rem]" style={{ gridTemplateColumns: `repeat(${courts.length}, minmax(var(--col-min), 1fr))` }}>
              {courts.map((c) => courtHead(c, "h-9 max-lg:sr-only"))}
              {courts.map((c, ci) => (
                <div key={c.id} className="relative rounded-lg border border-grid bg-white" style={{ height: times.length * ROW_PX }}>
                  {/* free slots; a slot under a booking or block is not a slot (disabled, hidden from keyboard and screen readers) */}
                  {times.map((t, i) => {
                    const covered = itemAt(c.id, i) !== null;
                    return (
                      <button
                        key={t}
                        data-cell={`${c.id}:${i}`}
                        onClick={() => { if (openSheet({ kind: "add", courtId: c.id, time: t })) returnTo.current = { kind: "cell", courtId: c.id, row: i }; }}
                        onFocus={() => { if (active.c !== ci || active.r !== i) setCell({ c: ci, r: i }); }}
                        disabled={!canAdd || covered}
                        aria-hidden={covered ? true : undefined}
                        tabIndex={!covered && active.c === ci && active.r === i ? 0 : -1}
                        aria-label={`Add booking ${c.name} ${t}`}
                        data-past={isToday && nowMin !== null && openMin + (i + 1) * club.slot_minutes <= nowMin ? "true" : undefined}
                        className={`absolute inset-x-0 border-t first:border-t-0 active:bg-slate-soft focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf ${i % labelEvery === 0 ? "border-grid" : "border-grid/50 border-dashed"} ${isToday && nowMin !== null && openMin + (i + 1) * club.slot_minutes <= nowMin ? PAST_BG_LG : ""}`}
                        style={{ top: i * ROW_PX, height: ROW_PX }}
                      />
                    );
                  })}
                  {/* blocks and bookings: each one Tab stop's worth when the active cell is inside it */}
                  {gridItems[c.id].map((it) => {
                    const id = itemKey(it);
                    const range = it.kind === "booking" ? `${hhmm(it.b.start_at, club.timezone)}–${hhmm(it.b.end_at, club.timezone)}` : `${hhmm(it.k.start_at, club.timezone)}–${hhmm(it.k.end_at, club.timezone)}`;
                    const pointAt = (e: React.MouseEvent<HTMLButtonElement>) => {
                      const row = Math.min(it.end - 1, it.row + Math.max(0, Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / ROW_PX)));
                      setPeek((p) => (p?.id === id && p.row === row ? p : { id, row }));
                    };
                    const common = {
                      "data-item": id,
                      tabIndex: activeItem && itemKey(activeItem) === id ? 0 : -1,
                      onFocus: () => {
                        const inside = active.c === ci && active.r >= it.row && active.r < it.end;
                        setPeek({ id, row: inside ? active.r : it.row });
                        if (!inside) setCell({ c: ci, r: it.row });
                      },
                      onBlur: () => setPeek((p) => (p?.id === id ? null : p)),
                      onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => pointAt(e),
                      onMouseMove: (e: React.MouseEvent<HTMLButtonElement>) => pointAt(e),
                      onMouseLeave: () => setPeek((p) => (p?.id === id ? null : p)),
                      style: { top: it.row * ROW_PX + 2, height: (it.end - it.row) * ROW_PX - 4 },
                    };
                    if (it.kind === "block") {
                      const k = it.k;
                      return (
                        <button key={id} {...common}
                          onClick={() => { if (openSheet({ kind: "block", block: k })) returnTo.current = { kind: "cell", courtId: c.id, row: it.row }; }}
                          aria-label={`${k.reason ?? "Blocked"}, ${c.name}, ${range}, blocked`}
                          className="hatch absolute inset-x-1 rounded-md border border-grid bg-slate-soft px-2 py-1 text-left text-xs text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-turf lg:text-sm">
                          {k.reason ?? "Blocked"}
                        </button>
                      );
                    }
                    const b = it.b;
                    const app = b.source === "app";
                    const pending = b.status === "pending";
                    const who = b.guest_name ?? b.player_name ?? "Player";
                    const phone = b.contact_phone ?? b.guest_phone;
                    return (
                      <button key={id} {...common}
                        onClick={() => { if (openSheet({ kind: "booking", booking: b })) returnTo.current = { kind: "cell", courtId: c.id, row: it.row }; }}
                        aria-label={`${who}, ${c.name}, ${range}, ${pending ? "being paid" : app ? "app booking" : "desk booking"}${phone ? `, ${phone}` : ""}`}
                        aria-current={sheet?.kind === "booking" && sheet.booking.id === b.id ? "true" : undefined}
                        className={`absolute inset-x-1 overflow-hidden rounded-md border-l-4 px-2 py-1 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-turf lg:text-sm ${sheet?.kind === "booking" && sheet.booking.id === b.id ? "ring-2 ring-ink" : foundIds.has(b.id) ? "ring-2 ring-turf" : ""} ${pending ? "border-dashed border-turf bg-white" : app ? "border-turf bg-turf-soft" : "border-sand bg-sand-soft"}`}>
                        <div className="truncate text-sm font-medium lg:text-[15px]">{pending ? "Paying…" : who}</div>
                        <div className="text-muted">{range}<span className="hidden lg:inline"> · {pending ? "being paid" : app ? "app" : "desk"}</span></div>
                        {phone && <div className="hidden truncate text-muted lg:block">{phone}</div>}
                      </button>
                    );
                  })}
                  {/* full details of the booking or block under the pointer or keyboard focus (desktop; the label says it too) */}
                  {(() => {
                    const it = peek ? gridItems[c.id].find((x) => itemKey(x) === peek.id) : undefined;
                    if (!it || !peek) return null;
                    // beside the row being pointed at or focused (a long block can fill the whole day): below it, or
                    // above it near the end of the day
                    const row = Math.min(Math.max(peek.row, it.row), it.end - 1);
                    const pos = row + 1 <= times.length - 3 ? { top: (row + 1) * ROW_PX + 2 } : { bottom: (times.length - row) * ROW_PX + 2 };
                    const range = it.kind === "booking" ? `${hhmm(it.b.start_at, club.timezone)}–${hhmm(it.b.end_at, club.timezone)}` : `${hhmm(it.k.start_at, club.timezone)}–${hhmm(it.k.end_at, club.timezone)}`;
                    return (
                      <div data-testid="peek" aria-hidden="true" style={pos}
                           className="pointer-events-none absolute left-1 z-30 hidden w-64 rounded-lg bg-ink px-3 py-2 text-sm text-white shadow-lg lg:block">
                        {it.kind === "booking" ? (
                          <>
                            <div className="font-semibold">{it.b.guest_name ?? it.b.player_name ?? "Player"}</div>
                            <div>{c.name} · {range}</div>
                            <div>{it.b.status === "pending" ? "Being paid" : it.b.source === "app" ? "App booking" : "Desk booking"}</div>
                            {(it.b.contact_phone ?? it.b.guest_phone) && <div>{it.b.contact_phone ?? it.b.guest_phone}</div>}
                          </>
                        ) : (
                          <>
                            <div className="font-semibold">{it.k.reason ?? "Blocked"}</div>
                            <div>{c.name} · {range} · blocked</div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                  {/* the open form's choice, not saved yet: above the free slots, never catching their taps */}
                  {(() => {
                    const d = draftOn(c.id, date);
                    if (!d) return null;
                    const row = (d.startMin - openMin) / club.slot_minutes, span = (d.endMin - d.startMin) / club.slot_minutes;
                    return (
                      <div data-testid="draft" aria-hidden="true"
                           className="pointer-events-none absolute inset-x-1 z-[5] overflow-hidden rounded-md border-2 border-dashed border-draft bg-draft-soft/90 px-2 py-1 text-left text-xs lg:text-sm"
                           style={{ top: row * ROW_PX + 2, height: span * ROW_PX - 4 }}>
                        <div className="font-semibold text-draft">Not saved</div>
                        <div className="text-ink">{minToHhmm(d.startMin)}–{minToHhmm(d.endMin)}{d.asBlock ? " · block" : ""}</div>
                      </div>
                    );
                  })()}
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
        <>
        {/* desktop (Phase I-2c): what the list holds, blocks included */}
        <p data-testid="list-count" className="mx-4 mb-2 hidden text-sm text-muted lg:block">{dayCount(shownBookings.length, shownBlocks.length)}</p>
        <ul className="mx-4 mb-24 divide-y divide-grid rounded-xl border border-grid bg-white">
          {shownBookings.length === 0 && <li className="p-8 text-center text-muted">No bookings this day. Tap a court slot in Courts view to add one.</li>}
          {listRows.map((r) => r.kind === "block" ? (
            <li key={r.k.id} className="hidden lg:block">
              <button onClick={() => openSheet({ kind: "block", block: r.k })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className="hatch h-10 w-1 rounded bg-slate-soft" />
                <div className="w-28 shrink-0">
                  <div className="font-medium">{hhmm(r.k.start_at, club.timezone)}–{hhmm(r.k.end_at, club.timezone)}</div>
                  <div className="text-sm text-muted">{courtName(r.k.court_id)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">Blocked{r.k.reason ? `: ${r.k.reason}` : ""}</div>
                </div>
              </button>
            </li>
          ) : (
            <li key={r.b.id}>
              <button onClick={() => openSheet({ kind: "booking", booking: r.b })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <span className={`h-10 w-1 rounded ${r.b.source === "app" ? "bg-turf" : "bg-sand"}`} />
                <div className="w-28 shrink-0">
                  <div className="font-medium">{hhmm(r.b.start_at, club.timezone)}–{hhmm(r.b.end_at, club.timezone)}</div>
                  <div className="text-sm text-muted">{courtName(r.b.court_id)}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.b.guest_name ?? r.b.player_name ?? "Player"}</div>
                  {r.b.guest_phone && <div className="text-sm text-muted">{r.b.guest_phone}</div>}
                </div>
                <span className="hidden shrink-0 text-sm text-muted lg:inline">{bookingType(r.b)}</span>
              </button>
            </li>
          ))}
        </ul>
        </>
      )}
      </div>
      </div>

      {/* One container for both layouts, restyled at 1024 px rather than replaced, so an open form keeps
          what was typed when the window crosses the breakpoint.
          Phones and tablets: the modal bottom sheet, as before. Desktop: a side panel beside the calendar,
          not modal — the calendar stays usable; with nothing open it shows the Now summary or a hint. */}
      {(sheet || isDesktop) && (
        <div
          className={isDesktop ? "sticky top-16 flex h-[calc(100vh-4rem)] w-[400px] shrink-0 flex-col border-l border-grid bg-white" : "fixed inset-0 z-20 flex items-end justify-center bg-ink/30"}
          onClick={isDesktop ? undefined : () => { if (!busy) { addDirty.current = false; setSheet(null); } }}
        >
          {sheet ? (
            <div ref={dialogRef} role="dialog" aria-modal={isDesktop ? "false" : "true"} aria-label={sheetTitle(sheet)}
              className={isDesktop ? "flex min-h-0 flex-1 flex-col outline-none" : "sheet-enter w-full max-w-lg rounded-t-2xl bg-white px-5 pb-8 pt-3 shadow-2xl outline-none"}
              onClick={(e) => e.stopPropagation()}>
              <div className={isDesktop ? "flex items-center justify-between border-b border-grid px-5 py-3" : "mx-auto mb-4 h-1 w-10 rounded-full bg-grid"}>
                {isDesktop && <h2 className="text-lg font-semibold">{sheetTitle(sheet)}</h2>}
                {isDesktop && (
                  <button type="button" aria-label="Close" disabled={busy} onClick={closeSheet}
                    className="grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-xl leading-none text-muted hover:text-ink disabled:opacity-40">×</button>
                )}
              </div>
              <div className={isDesktop ? "min-h-0 flex-1 overflow-y-auto px-5 py-4" : undefined}>
                {error && <p role={isDesktop ? "alert" : undefined} className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
                {sheetBody(sheet)}
              </div>
            </div>
          ) : isToday && view !== "now" ? (
            <div className="min-h-0 flex-1 overflow-y-auto py-4">
              <NowPanel
                compact club={club} courts={courts} bookings={shownBookings} freeNow={freeNow} sportNames={sportNames}
                showLater={showLater} onToggleLater={() => setShowLater((v) => !v)}
                onOpen={(b) => openSheet({ kind: "booking", booking: b })}
              />
            </div>
          ) : (
            <p className="px-5 py-6 text-sm text-muted">Select a booking to see its details, or a free time to add a booking.</p>
          )}
        </div>
      )}
      {isDesktop && (view === "grid" || view === "list") && typeof document !== "undefined" && createPortal(
        <PrintDay club={club} title={`${dayName} ${dayNum} ${monthName}`} sport={sport ? sportNames[sport] ?? sport : null}
          rows={listRows} courtName={courtName} bookings={shownBookings.length} blocks={shownBlocks.length} />,
        document.body,
      )}
    </main>
  );
}

/** Times that have ended today (Phase I-2c, desktop): a subtle flat grey, unlike a block's hatching; bookings stay as
 *  drawn. Earlier days and later times stay white (Paul, 21 Nov: a grey week looked disabled). */
const PAST_BG = "bg-[#eef0ed]";
const PAST_BG_LG = "lg:bg-[#eef0ed]";

const input = "rounded-xl border border-grid bg-paper px-4 py-3 text-base outline-none focus:border-action focus:ring-2 focus:ring-action/20";
/** Dropdowns: white with a clear border and a chevron when usable; a disabled one is grey with muted text (globals.css .select-field). */
const select = "select-field rounded-xl px-3 py-2 text-base";
const primary = "rounded-xl bg-action py-3.5 text-base font-medium text-white disabled:opacity-50";
const secondary = "rounded-xl border border-grid py-3.5 text-base";
const secondaryDanger = "rounded-xl border border-danger/40 py-3.5 text-base text-danger";
const backLink = "py-2 text-sm text-muted";

/** Enter in a text field never saves a booking or closes courts: only the button does (Phase I-2a). */
function noEnterSubmit(e: React.KeyboardEvent<HTMLFormElement>) {
  if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "submit") e.preventDefault();
}

/** The kind of booking, in words (never colour alone). */
function bookingType(b: Booking) {
  return b.status === "pending" ? "Being paid" : b.source === "app" ? "App" : "Desk";
}
function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}
/** "3 bookings", "3 bookings, 1 block", "No bookings". */
function dayCount(bookings: number, blocks: number) {
  return `${bookings ? plural(bookings, "booking") : "No bookings"}${blocks ? `, ${plural(blocks, "block")}` : ""}`;
}

/** Print the day (Phase I-2c, desktop): the browser's own Print with a plain sheet of the day shown — time, court,
 *  customer, type and blocks, and a column to tick arrivals. Never phone numbers. On screen it is not drawn. */
function PrintDay({ club, title, sport, rows, courtName, bookings, blocks }: {
  club: Club; title: string; sport: string | null; bookings: number; blocks: number;
  rows: ({ kind: "booking"; b: Booking } | { kind: "block"; k: Block })[];
  courtName: (id: string | null) => string;
}) {
  const range = (a: string, b: string) => `${hhmm(a, club.timezone)}–${hhmm(b, club.timezone)}`;
  return (
    <div id="print-day" data-testid="print-day" aria-hidden="true" className="hidden text-black print:block">
      <h1 className="text-xl font-semibold">{club.name} — {title}</h1>
      <p className="mb-3 text-sm">{sport ? `${sport} courts · ` : ""}{dayCount(bookings, blocks)} · printed {formatInTimeZone(new Date(), club.timezone, "d MMM HH:mm")}</p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-black text-left">
            <th className="py-1 pr-3">Time</th><th className="py-1 pr-3">Court</th><th className="py-1 pr-3">Customer</th><th className="py-1 pr-3">Type</th><th className="w-12 py-1">Here</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5} className="py-2">No bookings.</td></tr>}
          {rows.map((r) => r.kind === "block" ? (
            <tr key={r.k.id} className="border-b border-gray-400">
              <td className="py-1 pr-3 tabular-nums">{range(r.k.start_at, r.k.end_at)}</td>
              <td className="py-1 pr-3">{courtName(r.k.court_id)}</td>
              <td className="py-1 pr-3 italic" colSpan={2}>Blocked{r.k.reason ? `: ${r.k.reason}` : ""}</td>
              <td className="py-1" />
            </tr>
          ) : (
            <tr key={r.b.id} className="border-b border-gray-400">
              <td className="py-1 pr-3 tabular-nums">{range(r.b.start_at, r.b.end_at)}</td>
              <td className="py-1 pr-3">{courtName(r.b.court_id)}</td>
              <td className="py-1 pr-3">{r.b.guest_name ?? r.b.player_name ?? "Player"}</td>
              <td className="py-1 pr-3">{bookingType(r.b)}</td>
              <td className="py-1">☐</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtDur(m: number) {
  return m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60}`;
}

function closeMinutes(club: Club) {
  return club.close_time.startsWith("24:") ? 1440 : toMin(club.close_time);
}

/** Find a booking on this day (desktop): name or phone, among the bookings already on screen. ↓ moves into the
 *  results, ↑/↓ between them, Enter or a click opens one, Esc clears. Enter in the box itself does nothing. */
function FindBooking({ inputRef, value, onChange, results, courtName, tz, onOpen }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string; onChange: (v: string) => void; results: Booking[];
  courtName: (id: string | null) => string; tz: string; onOpen: (b: Booking) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const shown = value.trim().length > 0;
  return (
    <div className="relative hidden lg:block">
      <input ref={inputRef} type="search" value={value} aria-label="Find a booking on this day (name or phone)" placeholder="Find booking: name or phone"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault();
          else if (e.key === "Escape" && value) { e.preventDefault(); e.stopPropagation(); onChange(""); }
          else if (e.key === "ArrowDown" && results.length) { e.preventDefault(); items()[0]?.focus(); }
        }}
        className="h-9 w-56 rounded-lg border border-[#8a918e] bg-white px-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-turf" />
      {shown && <span className="sr-only" aria-live="polite">{results.length === 1 ? "1 booking found" : `${results.length} bookings found`}</span>}
      {shown && (
        <ul ref={listRef} aria-label="Matching bookings" className="absolute right-0 top-10 z-40 w-80 divide-y divide-grid rounded-xl border border-grid bg-white text-sm text-ink shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-muted">No booking on this day matches.</li>}
          {results.map((b, i) => (
            <li key={b.id}>
              <button type="button" onClick={() => onOpen(b)}
                onKeyDown={(e) => {
                  const all = items();
                  if (e.key === "ArrowDown") { e.preventDefault(); all[Math.min(all.length - 1, i + 1)]?.focus(); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); (i === 0 ? inputRef.current : all[i - 1])?.focus(); }
                  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); inputRef.current?.focus(); }
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-paper focus-visible:bg-paper focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf">
                <span className="w-24 shrink-0 tabular-nums">{hhmm(b.start_at, tz)}–{hhmm(b.end_at, tz)}</span>
                <span className="w-16 shrink-0 text-muted">{courtName(b.court_id)}</span>
                <span className="min-w-0 flex-1 truncate">{b.guest_name ?? b.player_name ?? "Player"}</span>
                {(b.contact_phone ?? b.guest_phone) && <span className="shrink-0 text-muted">{b.contact_phone ?? b.guest_phone}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Week keyboard (Phase I-2b): one Tab stop; ↑/↓ times, ←/→ days, Home/End; Enter is the focused cell's own key.
 *  Shared by the one-court week and the All courts week (Phase I-2c). */
function useWeekKeys(days: string[], times: string[], today: string, rootRef?: React.RefObject<HTMLDivElement | null>) {
  const [wc, setWc] = useState({ d: Math.max(0, days.indexOf(today)), r: 0 });
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    rootRef?.current?.querySelector<HTMLElement>(`[data-week-cell="${days[wc.d]}|${times[wc.r]}"]`)?.focus();
  });
  const isActive = (d: string, t: string) => days[wc.d] === d && times[wc.r] === t;
  const cellProps = (d: string, t: string) => ({
    "data-week-cell": `${d}|${t}`,
    tabIndex: isActive(d, t) ? 0 : -1,
    onFocus: () => { const n = { d: days.indexOf(d), r: times.indexOf(t) }; if (n.d !== wc.d || n.r !== wc.r) setWc(n); },
  });
  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.closest("[data-week-cell]")) return;
    e.preventDefault();
    let { d, r } = wc;
    if (e.key === "ArrowLeft") d = Math.max(0, d - 1);
    else if (e.key === "ArrowRight") d = Math.min(days.length - 1, d + 1);
    else if (e.key === "ArrowUp") r = Math.max(0, r - 1);
    else if (e.key === "ArrowDown") r = Math.min(times.length - 1, r + 1);
    else if (e.key === "Home") r = 0;
    else r = times.length - 1;
    focusNext.current = true;
    setWc({ d, r });
  }
  return { wc, isActive, cellProps, onKey };
}

/** The club's today and current minute, ticking every minute (Week views: past shading and the now line). */
function useClubClock(tz: string) {
  const [clock, setClock] = useState<{ today: string; nowMin: number } | null>(null);
  useEffect(() => {
    const tick = () => setClock({ today: todayIn(tz), nowMin: toMin(formatInTimeZone(new Date(nowMs()), tz, "HH:mm")) });
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [tz]);
  return clock;
}

const dayLabelOf = (d: string, tz: string) => formatInTimeZone(clubLocalToUtc(d, "12:00", tz), tz, "EEE d MMM");

/** The red now line over today's column (desktop). Above the drawn bookings, below a focused cell's outline. */
function WeekNowLine({ clock, days, times, slot, rowPx }: { clock: { today: string; nowMin: number } | null; days: string[]; times: string[]; slot: number; rowPx: number }) {
  const di = clock ? days.indexOf(clock.today) : -1;
  if (!clock || di < 0) return null;
  const open = toMin(times[0]);
  if (clock.nowMin < open || clock.nowMin > open + times.length * slot) return null;
  return (
    <div aria-hidden="true" data-testid="week-now" style={{ gridColumn: di + 2, gridRow: `2 / ${times.length + 2}` }} className="pointer-events-none relative z-[4] hidden lg:block">
      <div className="absolute inset-x-0 border-t-2 border-danger" style={{ top: ((clock.nowMin - open) / slot) * rowPx }} />
    </div>
  );
}

/** One court, seven days. Days are columns because seven of them fit a phone and five courts do not.
 *  Time labels stay in a sticky gutter, a cell opens the usual sheets, and a column header opens that
 *  day in the Courts view. Desktop (Phase I-2c): each booking or block is also drawn as one block over exactly
 *  the cells it covers (computed from those cells), with name, time and type; the cells underneath stay the
 *  keyboard and click targets, unchanged since I-2b. Every grid item is placed explicitly so the drawn blocks
 *  can sit on top of the cells. */
function WeekGrid({ club, court, days, times, today, data, canAdd, dayHref, onOpenBooking, onOpenBlock, onAdd, draft, rootRef }: {
  club: Club; court: Court | null; days: string[]; times: string[]; today: string;
  /** the grid element: focus comes back here when nothing better is available */
  rootRef?: React.RefObject<HTMLDivElement | null>;
  /** the open add form's choice on this court, not saved yet */
  draft?: (Selection & { day: string }) | null;
  data: { bookings: Booking[]; blocks: Block[] } | null;
  canAdd: boolean;
  dayHref: (d: string) => string;
  onOpenBooking: (b: Booking, day: string, time: string) => void;
  onOpenBlock: (b: Block, day: string, time: string) => void;
  onAdd: (date: string, time: string) => void;
}) {
  const { wc, cellProps, onKey } = useWeekKeys(days, times, today, rootRef);
  const clock = useClubClock(club.timezone);
  // the booking or block whose details are shown, at the cell pointed at or focused (desktop)
  const [peek, setPeek] = useState<{ d: number; r: number } | null>(null);
  const tz = club.timezone;
  // what sits on this court at each day and time, worked out once per week read (not on every draw). The parent
  // rebuilds the day and time lists on every draw, so the memo keys on their contents.
  const daysKey = days.join(","), timesKey = times.join(",");
  const grid = useMemo(() => daysKey.split(",").map((d) => timesKey.split(",").map((t) => {
    const ms = clubLocalToUtc(d, t, tz).getTime();
    if (!data) return { ms, cell: null };
    const b = data.bookings.find((x) => Date.parse(x.start_at) <= ms && Date.parse(x.end_at) > ms);
    if (b) return { ms, cell: { kind: "booking" as const, b } };
    const k = data.blocks.find((x) => Date.parse(x.start_at) <= ms && Date.parse(x.end_at) > ms);
    return { ms, cell: k ? { kind: "block" as const, k } : null };
  })), [data, daysKey, timesKey, tz]);
  const dayLabels = useMemo(() => daysKey.split(",").map((d) => dayLabelOf(d, tz)), [daysKey, tz]);
  if (!court) return <p className="px-4 py-10 text-center text-sm text-muted">No active courts for this sport.</p>;
  const loading = data === null;
  const rowPx = club.slot_minutes <= 30 ? 34 : 48;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1;

  const at = (d: string, t: string) => grid[days.indexOf(d)]?.[times.indexOf(t)]?.cell ?? null;
  type Cell = NonNullable<ReturnType<typeof at>>;
  const cellId = (c: Cell) => (c.kind === "booking" ? c.b.id : c.k.id);
  const activeFree = !at(days[wc.d], times[wc.r]);
  // only today's elapsed times are shaded; earlier days keep a white grid
  const ended = (d: string, i: number) => !!clock && d === clock.today && toMin(times[i]) + club.slot_minutes <= clock.nowMin;
  const range = (c: Cell) => c.kind === "booking" ? `${hhmm(c.b.start_at, tz)}–${hhmm(c.b.end_at, tz)}` : `${hhmm(c.k.start_at, tz)}–${hhmm(c.k.end_at, tz)}`;
  const who = (b: Booking) => b.guest_name ?? b.player_name ?? "Player";
  const kindWord = (b: Booking) => (b.status === "pending" ? "being paid" : b.source === "app" ? "app booking" : "desk booking");

  // the drawn blocks: runs of consecutive cells of one day that belong to the same booking or block
  type Seg = { di: number; r0: number; r1: number; c: Cell };
  const segs: Seg[] = [];
  for (let di = 0; di < days.length; di++) {
    let cur: Seg | null = null;
    for (let r = 0; r < times.length; r++) {
      const c = grid[di][r].cell;
      if (cur && c && cellId(cur.c) === cellId(c)) { cur.r1 = r + 1; continue; }
      if (cur) segs.push(cur);
      cur = c ? { di, r0: r, r1: r + 1, c } : null;
    }
    if (cur) segs.push(cur);
  }
  const bookingsOn = (di: number) => new Set(segs.filter((g) => g.di === di && g.c.kind === "booking").map((g) => cellId(g.c))).size;
  const closedOn = (di: number) => segs.some((g) => g.di === di && g.c.kind === "block" && g.r0 === 0 && g.r1 === times.length);
  const peekCell = peek ? at(days[peek.d], times[peek.r]) : null;
  const peekProps = (di: number, r: number) => ({
    onMouseEnter: () => setPeek({ d: di, r }),
    onMouseLeave: () => setPeek((p) => (p?.d === di && p.r === r ? null : p)),
    onBlur: () => setPeek((p) => (p?.d === di && p.r === r ? null : p)),
  });

  return (
    <div className={`mb-24 overflow-x-auto lg:overflow-visible ${loading ? "pointer-events-none opacity-50" : ""}`}>
      <div className="min-w-[340px] px-2">
        <span id="week-keys-hint" className="sr-only">Arrow keys move between times and days; Enter opens the free time, booking or block.</span>
        <div ref={rootRef} role="group" aria-label={`Week, ${court.name}`} aria-describedby="week-keys-hint" onKeyDown={onKey}
             tabIndex={activeFree && !canAdd ? 0 : -1}
             className="grid outline-none focus-visible:ring-2 focus-visible:ring-turf" style={{ gridTemplateColumns: `3rem repeat(7, minmax(2.5rem, 1fr))` }}>
          <div className="sticky left-0 z-10 bg-paper lg:top-0 lg:z-30" style={{ gridColumn: 1, gridRow: 1 }} />
          {days.map((d, di) => (
            <Link key={d} href={dayHref(d)} style={{ gridColumn: di + 2, gridRow: 1 }}
                  className={`border-b border-grid pb-1 text-center text-xs leading-tight lg:sticky lg:top-0 lg:z-20 lg:px-2 lg:pt-1 lg:text-left ${d === today ? "font-semibold text-turf lg:bg-turf-soft" : "text-muted lg:bg-paper"}`}>
              <div className="lg:hidden">
                <div>{formatInTimeZone(clubLocalToUtc(d, "12:00", tz), tz, "EEE")}</div>
                <div className="text-sm text-ink">{formatInTimeZone(clubLocalToUtc(d, "12:00", tz), tz, "d")}</div>
                <div className="tabular-nums">{loading ? "·" : `${grid[di].filter((g) => g.cell !== null).length}/${times.length}`}</div>
              </div>
              <div className="hidden lg:block" data-testid="week-day-heading">
                <div className="text-[15px] font-semibold text-ink">{dayLabels[di]}{d === today && <span className="ml-1.5 text-xs font-semibold text-turf">Today</span>}</div>
                <div className="text-[13px] font-normal text-muted">{loading ? "·" : closedOn(di) ? "Closed" : dayCount(bookingsOn(di), 0)}</div>
              </div>
            </Link>
          ))}

          {times.map((t, i) => (
            <div key={t} className="contents">
              <div className="sticky left-0 z-10 bg-paper pr-1 text-right text-[11px] text-muted lg:text-[13px]" style={{ height: rowPx, gridColumn: 1, gridRow: i + 2 }}>
                {i % labelEvery === 0 ? t : ""}
              </div>
              {days.map((d, di) => {
                const cell = grid[di][i].cell;
                const place = { gridColumn: di + 2, gridRow: i + 2, height: rowPx };
                if (!cell) {
                  // inside the open form's choice: drawn "not saved", still a free slot to tap
                  const m = toMin(t);
                  const inDraft = draft && draft.day === d && m >= draft.startMin && m < draft.endMin;
                  const head = inDraft && m === draft.startMin;
                  const past = ended(d, i);
                  return (
                    <button key={d + t} {...cellProps(d, t)} onClick={() => onAdd(d, t)} disabled={!canAdd} aria-label={`Add a booking on ${d} at ${t}`}
                            data-draft={inDraft ? "true" : undefined} data-past={past ? "true" : undefined}
                            className={`relative border-l focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf disabled:cursor-not-allowed ${inDraft ? "border-x-2 border-dashed border-draft bg-draft-soft" : `border-b border-grid/60 bg-white ${past ? PAST_BG_LG : ""}`} ${head ? "border-t-2" : ""} ${inDraft && m + club.slot_minutes === draft.endMin ? "border-b-2" : ""}`}
                            style={place}>
                      {head && <span aria-hidden="true" className="absolute inset-x-0 top-0.5 truncate px-0.5 text-[10px] font-semibold leading-tight text-draft">Not saved</span>}
                    </button>
                  );
                }
                if (cell.kind === "block") {
                  const k = cell.k;
                  return (
                    <button key={d + t} {...cellProps(d, t)} {...peekProps(di, i)}
                            onFocus={() => { cellProps(d, t).onFocus(); setPeek({ d: di, r: i }); }}
                            onClick={() => onOpenBlock(k, d, t)}
                            aria-label={`${k.reason ?? "Blocked"}, ${court.name}, ${dayLabels[di]}, ${range(cell)}, blocked`}
                            className="relative border-b border-l border-grid/60 bg-[repeating-linear-gradient(45deg,#e7e5e4_0,#e7e5e4_3px,#fff_3px,#fff_6px)] focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf lg:bg-none" style={place} />
                  );
                }
                const b = cell.b;
                const head = Math.abs(grid[di][i].ms - Date.parse(b.start_at)) < 60_000;
                return (
                  <button key={d + t} {...cellProps(d, t)} {...peekProps(di, i)}
                          onFocus={() => { cellProps(d, t).onFocus(); setPeek({ d: di, r: i }); }}
                          onClick={() => onOpenBooking(b, d, t)}
                          aria-label={`${who(b)}, ${court.name}, ${dayLabels[di]}, ${range(cell)}, ${kindWord(b)}`}
                          className={`relative border-l border-grid/60 focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf lg:bg-transparent ${head ? "border-t" : ""} ${b.status === "pending" ? "border-dashed bg-sand/40" : b.source === "app" ? "bg-turf-soft" : "bg-sand"}`}
                          style={place}>
                    {head && (
                      <span className="absolute inset-x-0 top-0.5 truncate px-0.5 text-[10px] font-medium leading-tight lg:hidden">
                        {b.status === "pending" ? "pay…" : who(b).split(" ")[0]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* desktop: each booking or block drawn once over exactly its cells; never takes clicks or focus */}
          {segs.map((g) => {
            const span = g.r1 - g.r0;
            const c = g.c;
            const tone = c.kind === "block" ? "hatch border border-grid bg-slate-soft text-muted"
              : c.b.status === "pending" ? "border border-l-4 border-dashed border-turf bg-white"
              : c.b.source === "app" ? "border-l-4 border-turf bg-turf-soft" : "border-l-4 border-sand bg-sand-soft";
            const title = c.kind === "booking" ? who(c.b) : c.k.reason ?? "Blocked";
            const type = c.kind === "booking" ? (c.b.status === "pending" ? "being paid" : c.b.source === "app" ? "app" : "desk") : "blocked";
            return (
              <div key={`${cellId(c)}|${g.di}`} aria-hidden="true" data-week-block={cellId(c)} data-rows={`${g.r0}-${g.r1}`}
                   style={{ gridColumn: g.di + 2, gridRow: `${g.r0 + 2} / ${g.r1 + 2}` }}
                   className={`pointer-events-none relative z-[3] mx-[3px] my-[2px] hidden overflow-hidden rounded-md px-1.5 py-0.5 text-left leading-tight lg:block ${tone}`}>
                {span === 1 ? (
                  <div className="truncate text-[13px]"><span className="font-medium text-ink">{title}</span> <span className="text-xs text-muted">{range(c)}</span></div>
                ) : (
                  <>
                    {/* name, then time and type on lines of their own: a week column is narrow */}
                    <div className={`text-[13px] font-medium text-ink ${span >= 3 ? "line-clamp-2" : "truncate"}`}>{title}</div>
                    <div className="truncate text-xs text-muted tabular-nums">{range(c)}</div>
                    <div className="truncate text-xs text-muted">{type}</div>
                  </>
                )}
              </div>
            );
          })}

          <WeekNowLine clock={clock} days={days} times={times} slot={club.slot_minutes} rowPx={rowPx} />

          {/* full details of the booking or block pointed at or focused (desktop; the label says it too) */}
          {peek && peekCell && (
            <div aria-hidden="true" style={{ gridColumn: peek.d + 2, gridRow: peek.r + 2 }} className="pointer-events-none relative z-30 hidden lg:block">
              <div data-testid="week-peek" className={`absolute w-64 rounded-lg bg-ink px-3 py-2 text-sm text-white shadow-lg ${peek.r <= times.length - 4 ? "top-full mt-1" : "bottom-full mb-1"} ${peek.d >= 5 ? "right-0" : "left-0"}`}>
                {peekCell.kind === "booking" ? (
                  <>
                    <div className="font-semibold">{who(peekCell.b)}</div>
                    <div>{court.name} · {dayLabels[peek.d]} · {range(peekCell)}</div>
                    <div>{peekCell.b.status === "pending" ? "Being paid" : peekCell.b.source === "app" ? "App booking" : "Desk booking"}</div>
                    {(peekCell.b.contact_phone ?? peekCell.b.guest_phone) && <div>{peekCell.b.contact_phone ?? peekCell.b.guest_phone}</div>}
                  </>
                ) : (
                  <>
                    <div className="font-semibold">{peekCell.k.reason ?? "Blocked"}</div>
                    <div>{court.name} · {dayLabels[peek.d]} · {range(peekCell)} · blocked</div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <p className="px-2 py-3 text-xs text-muted">
          <span className="lg:hidden">Tap a booking for its details, or a day at the top to open that day court by court.</span>
          <span className="hidden lg:inline">Click a booking for its details (pointing at it shows them too), or a day heading to open that day court by court.</span>
        </p>
      </div>
    </div>
  );
}

/** All courts week (Phase I-2c, desktop): for each time, how many courts of the shown sport are free — not taken by a
 *  confirmed booking, an unexpired hold or a block. It says nothing about whether a longer booking fits, and the
 *  database still decides when saving. A time opens that day in Courts at that time.
 *  Fails safe (review): counts are shown only from a read that succeeded and is current — `data` is null while the
 *  week is loading (a quiet automatic refresh excepted), after a failed read or refresh, and until a read succeeds.
 *  Then no count is worked out or shown and no time can be followed; the keyboard still moves over the grid. */
function AllCourtsWeek({ club, courts, days, times, data, failed = false, cellHref, dayHref, rootRef }: {
  club: Club; courts: Court[]; days: string[]; times: string[];
  /** a verified read for this week and these courts, else null */
  data: { bookings: Taken[]; blocks: Taken[] } | null;
  /** the last read failed (the page banner offers Retry) */
  failed?: boolean;
  cellHref: (d: string, t: string) => string;
  dayHref: (d: string) => string;
  rootRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const tz = club.timezone;
  const clock = useClubClock(tz);
  const today = clock?.today ?? todayIn(tz);
  const { cellProps, onKey } = useWeekKeys(days, times, today, rootRef);
  // free courts at each day and time, worked out once per week read and minute (a hold counts only until it
  // expires — checked against the clock, not only when the week was read)
  const nowKey = clock ? `${clock.today}|${clock.nowMin}` : "";
  const daysKey = days.join(","), timesKey = times.join(","), courtsKey = courts.map((c) => c.id).join(",");
  const slot = club.slot_minutes;
  const free = useMemo(() => {
    if (!data) return null;                                  // nothing verified: no count, never "all free"
    const now = nowMs();
    const taken = new Map<string, [number, number][]>();
    for (const r of [...data.bookings.filter((b) => b.status !== "pending" || (b.hold_expires_at && Date.parse(b.hold_expires_at) > now)), ...data.blocks]) {
      const list = taken.get(r.court_id) ?? [];
      list.push([Date.parse(r.start_at), Date.parse(r.end_at)]);
      taken.set(r.court_id, list);
    }
    const ids = courtsKey.split(",");
    return daysKey.split(",").map((d) => timesKey.split(",").map((t) => {
      const s = clubLocalToUtc(d, t, tz).getTime(), e = s + slot * 60_000;
      return ids.filter((id) => !(taken.get(id) ?? []).some(([a, b]) => a < e && b > s)).length;
    }));
  }, [data, daysKey, timesKey, courtsKey, tz, slot, nowKey]);   // eslint-disable-line react-hooks/exhaustive-deps -- nowKey: holds expire with the clock
  const dayLabels = useMemo(() => daysKey.split(",").map((d) => dayLabelOf(d, tz)), [daysKey, tz]);
  if (!courts.length) return <p className="px-4 py-10 text-center text-sm text-muted">No active courts for this sport.</p>;
  const rowPx = club.slot_minutes <= 30 ? 34 : 48;
  const labelEvery = club.slot_minutes <= 30 ? 2 : 1;
  const total = courts.length;
  // only today's elapsed times are shaded; earlier days keep a white grid
  const ended = (d: string, i: number) => !!clock && d === clock.today && toMin(times[i]) + club.slot_minutes <= clock.nowMin;
  const tone = (n: number) => n === total ? "bg-white text-turf" : n === 0 ? "bg-[#cfd4ce] font-semibold text-ink" : n / total >= 0.5 ? "bg-[#eef3ef] text-ink" : "bg-[#dde5df] text-ink";

  return (
    <div className="mb-24">
      <div className="px-2">
        <p id="all-week-hint" className="px-2 pb-2 text-[13px] text-muted">
          Courts free in each {fmtDur(slot)} slot. A longer booking may not fit: open a time to see each court. Saving always checks again.
        </p>
        {!free && (
          <p role="status" data-testid="all-week-status" className="mx-2 mb-2 rounded-lg border border-grid bg-white px-3 py-2 text-[13px] text-ink">
            {failed ? "Availability could not be loaded, so no counts are shown. Use Retry above." : "Loading availability…"}
          </p>
        )}
        <span id="week-keys-hint" className="sr-only">Arrow keys move between times and days; Enter opens that day in Courts at that time.</span>
        <div ref={rootRef} role="group" aria-label="Week, all courts" aria-describedby="all-week-hint week-keys-hint" onKeyDown={onKey}
             className="grid outline-none" style={{ gridTemplateColumns: `3rem repeat(7, minmax(2.5rem, 1fr))` }}>
          <div className="sticky left-0 top-0 z-30 bg-paper" style={{ gridColumn: 1, gridRow: 1 }} />
          {days.map((d, di) => (
            <Link key={d} href={dayHref(d)} style={{ gridColumn: di + 2, gridRow: 1 }}
                  className={`sticky top-0 z-20 border-b border-grid px-2 pb-1 pt-1 text-left leading-tight ${d === today ? "bg-turf-soft" : "bg-paper"}`}>
              <div className="text-[15px] font-semibold text-ink">{dayLabels[di]}{d === today && <span className="ml-1.5 text-xs font-semibold text-turf">Today</span>}</div>
            </Link>
          ))}
          {times.map((t, i) => (
            <div key={t} className="contents">
              <div className="sticky left-0 z-10 bg-paper pr-1 text-right text-[13px] text-muted" style={{ height: rowPx, gridColumn: 1, gridRow: i + 2 }}>
                {i % labelEvery === 0 ? t : ""}
              </div>
              {days.map((d, di) => {
                const past = ended(d, i);
                const place = { gridColumn: di + 2, gridRow: i + 2, height: rowPx };
                if (!free) {
                  // not verified: no count and nothing to follow; still a stop for the arrow keys
                  return (
                    <button key={d + t} type="button" {...cellProps(d, t)} aria-disabled="true" data-unverified="true"
                            aria-label={`${dayLabels[di]}, ${t}: ${failed ? "availability not loaded" : "loading"}`} style={place}
                            className={`relative cursor-not-allowed border-b border-l border-grid/60 text-[13px] text-muted focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf ${past ? PAST_BG : "bg-white"}`}>
                      <span aria-hidden="true">–</span>
                    </button>
                  );
                }
                const n = free[di][i];
                return (
                  <Link key={d + t} {...cellProps(d, t)} href={cellHref(d, t)} data-free={n} data-past={past ? "true" : undefined}
                        aria-label={`${n} of ${total} courts free, ${dayLabels[di]}, ${t}`}
                        style={place}
                        className={`relative flex items-center justify-center border-b border-l border-grid/60 text-[13px] tabular-nums focus-visible:z-[6] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-turf ${past ? `${PAST_BG} text-muted` : tone(n)}`}>
                    {n === 0 ? "Full" : `${n} free`}
                  </Link>
                );
              })}
            </div>
          ))}
          <WeekNowLine clock={clock} days={days} times={times} slot={club.slot_minutes} rowPx={rowPx} />
        </div>
      </div>
    </div>
  );
}

/** What the desk sees when it opens the calendar: on court now, next three hours, then the rest. */
function NowPanel({ club, courts, bookings, freeNow, sportNames, showLater, onToggleLater, onOpen, compact = false }: {
  club: Club; courts: Court[]; bookings: Booking[]; freeNow: FreeNow[] | null; sportNames: Record<string, string>;
  showLater: boolean; onToggleLater: () => void; onOpen: (b: Booking) => void;
  /** the desktop side panel: no page margins */
  compact?: boolean;
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
    <div className={compact ? "flex flex-col gap-4 px-4" : "mx-4 mb-24 flex flex-col gap-4"}>
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

/** What the add form has chosen, for the provisional highlight on the grid (minutes after club midnight). */
export type Selection = { startMin: number; endMin: number; asBlock: boolean };

export function AddSheet({ club, court, time, busy, defaultMinutes, onSave, onDirty, taken = [], endedBefore = -1, onSelection }: {
  club: Club; court: Court; time: string; busy: boolean; defaultMinutes: number | null;
  /** a block also passes its own start and end ("HH:mm"; end "24:00" = midnight), which the desk chose */
  onSave: (name: string, phone: string, slots: number, asBlock: boolean, start?: string, end?: string) => void;
  /** true while the desk has typed or chosen details that are not saved yet */
  onDirty?: (dirty: boolean) => void;
  /** bookings, holds and blocks already on this court that day, from the calendar's rows */
  taken?: readonly Busy[];
  /** minutes before which every slot of that day has ended (see blockStartOptions) */
  endedBefore?: number;
  /** the chosen interval, on every change, and null when the form goes away */
  onSelection?: (s: Selection | null) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // a block's reason is its own field: switching modes never turns a customer's name into a reason
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState(false);
  const [hints, setHints] = useState<Guest[]>([]);
  // keyboard choice among the suggestions (Phase I-2b): ↓/↑ highlight, Enter picks (never saves), Esc closes
  const [hi, setHi] = useState(-1);
  const showHints = (h: Guest[]) => { setHints(h); setHi(-1); };
  const lengthRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  function pickGuest(g: Guest) {
    setName(g.name); setPhone(g.phone ?? ""); setPicked(true); showHints([]);
    // then on to the booking length (or the phone when no length fits)
    setTimeout(() => (lengthRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? phoneRef.current)?.focus(), 0);
  }
  // a length, start or end the desk chose: switching slots asks first, like typed text
  const [touched, setTouched] = useState(false);
  // bookings get the club's minimum to maximum; a block has its own start and end (see durations.ts)
  const [asBlock, setAsBlock] = useState(false);
  const openMin = toMin(club.open_time);
  const closeMin = closeMinutes(club);
  const bookOpts = bookingSlotOptions(club, toMin(time), closeMin);
  const wanted = Math.max(1, Math.round((defaultMinutes ?? club.min_booking_minutes) / club.slot_minutes));
  const [wish, setWish] = useState(wanted);
  const slots = pickSlots(bookOpts, wish, Math.round(club.min_booking_minutes / club.slot_minutes));

  // block: start on the grid (the tapped slot unless it is taken or over), end up to closing or the next taken time
  const starts = blockStartOptions(club, openMin, closeMin, taken, endedBefore);
  const [startWish, setStartWish] = useState(toMin(time));
  const bStart = starts.includes(startWish) ? startWish : (starts.find((m) => m >= startWish) ?? null);
  const ends = bStart === null ? [] : blockEndOptions(club, bStart, closeMin, taken);
  const [endWish, setEndWish] = useState<number | null>(null);
  const bEnd = endWish !== null && ends.includes(endWish) ? endWish
    : ends.includes((bStart ?? 0) + wanted * club.slot_minutes) ? (bStart ?? 0) + wanted * club.slot_minutes
    : ends[ends.length - 1] ?? null;

  const selection: Selection | null = asBlock
    ? (bStart !== null && bEnd !== null ? { startMin: bStart, endMin: bEnd, asBlock: true } : null)
    : (slots !== null ? { startMin: toMin(time), endMin: toMin(time) + slots * club.slot_minutes, asBlock: false } : null);
  const selKey = selection ? `${selection.startMin}-${selection.endMin}-${selection.asBlock}` : "";
  useEffect(() => { onSelection?.(selection); }, [selKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onSelection?.(null), []);            // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onDirty?.(Boolean(name.trim() || phone.trim() || reason.trim() || touched)); }, [name, phone, reason, touched, onDirty]);

  // customers this club has booked before, matched on what the desk has typed so far
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (picked || name.trim().length < 2) { if (alive) showHints([]); return; }
      const { data } = await createClient().rpc("club_recent_guests", { p_club: club.id, p_query: name.trim() });
      if (alive) showHints(((data as Guest[] | null) ?? []).slice(0, 5));
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [name, picked, club.id]);

  const heading = asBlock
    ? `${court.name}, ${bStart !== null ? minToHhmm(bStart) : time}${bEnd !== null ? `–${minToHhmm(bEnd)}` : ""} · block`
    : `${court.name}, ${time}${slots !== null ? `–${minToHhmm(toMin(time) + slots * club.slot_minutes)}` : ""}`;
  return (
    <form className="flex flex-col gap-3" onKeyDown={noEnterSubmit} onSubmit={(e) => {
      e.preventDefault();
      if (asBlock) {
        if (bStart === null || bEnd === null) return;
        onSave(reason.trim(), "", (bEnd - bStart) / club.slot_minutes, true, minToHhmm(bStart), minToHhmm(bEnd));
      } else if (slots !== null) onSave(name.trim(), phone.trim(), slots, false);
    }}>
      <h2 className="text-lg font-semibold">{heading}</h2>
      {asBlock ? (
        <input key="reason" className={input} placeholder="Reason (optional)" aria-label="Block reason" value={reason} autoFocus
               onChange={(e) => setReason(e.target.value)} />
      ) : (
        <input key="name" className={input} placeholder="Name" aria-label="Customer name" required value={name} autoFocus
               role="combobox" aria-autocomplete="list" aria-expanded={hints.length > 0} aria-controls="guest-hints"
               aria-activedescendant={hi >= 0 && hints[hi] ? `guest-hint-${hi}` : undefined}
               onChange={(e) => { setName(e.target.value); setPicked(false); }}
               onKeyDown={(e) => {
                 if (!hints.length) return;
                 if (e.key === "ArrowDown") { e.preventDefault(); setHi((i) => (i + 1) % hints.length); }
                 else if (e.key === "ArrowUp") { e.preventDefault(); setHi((i) => (i <= 0 ? hints.length - 1 : i - 1)); }
                 // Enter picks the highlighted customer; it never saves (the form's Enter guard also stops it)
                 else if (e.key === "Enter" && hi >= 0 && hints[hi]) { e.preventDefault(); pickGuest(hints[hi]); }
                 // Esc closes the list only, not the panel
                 else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); showHints([]); }
               }} />
      )}
      {!asBlock && hints.length > 0 && (
        <ul id="guest-hints" role="listbox" aria-label="Recent customers" className="-mt-1 divide-y divide-grid rounded-xl border border-grid bg-paper text-sm">
          {hints.map((g, i) => (
            // a suggestion fills this customer's own phone, or clears it when they have none
            <li key={`${g.name}|${g.phone ?? ""}`} id={`guest-hint-${i}`} role="option" aria-selected={i === hi}
                onMouseDown={(e) => e.preventDefault()} onClick={() => pickGuest(g)}
                className={`flex cursor-pointer items-center justify-between px-3 py-2 text-left ${i === hi ? "bg-turf-soft" : ""}`}>
              <span className="truncate">{g.name}</span>
              <span className="ml-3 shrink-0 text-muted">{g.phone ?? "no phone"}</span>
            </li>
          ))}
        </ul>
      )}
      {!asBlock && <input ref={phoneRef} className={input} placeholder="Phone (optional)" aria-label="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
      {asBlock ? (
        bStart !== null && bEnd !== null ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-sm text-muted">Start
                <select className={select} aria-label="Block start" disabled={busy} value={bStart}
                        onChange={(e) => { setStartWish(Number(e.target.value)); setTouched(true); }}>
                  {starts.map((m) => <option key={m} value={m}>{minToHhmm(m)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-muted">End
                <select className={select} aria-label="Block end" disabled={busy} value={bEnd}
                        onChange={(e) => { setEndWish(Number(e.target.value)); setTouched(true); }}>
                  {ends.map((m) => <option key={m} value={m}>{minToHhmm(m)}</option>)}
                </select>
              </label>
            </div>
            <p className="-mt-1 text-xs text-muted">{fmtDur(bEnd - bStart)}. Ends by closing ({minToHhmm(closeMin)}) or the next booking or block on this court.</p>
          </>
        ) : (
          <p className="text-sm text-muted">Not enough time before closing for a block.</p>
        )
      ) : bookOpts.length > 0 ? (
        <div ref={lengthRef} className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Booking length">
          {bookOpts.map((n) => (
            <button type="button" key={n} role="radio" aria-checked={slots === n} onClick={() => { setWish(n); if (n !== slots) setTouched(true); }}
                    className={`rounded-xl border py-2 text-sm ${slots === n ? "border-ink bg-ink text-white" : "border-grid"}`}>
              {fmtDur(n * club.slot_minutes)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">
          {`Not enough time before closing for a booking. Bookings here: ${fmtDur(club.min_booking_minutes)} to ${fmtDur(club.max_booking_minutes)}.`}
        </p>
      )}
      {!asBlock && bookOpts.length > 0 && (
        <p className="-mt-1 text-xs text-muted">Bookings at this club: {fmtDur(club.min_booking_minutes)} to {fmtDur(club.max_booking_minutes)}.</p>
      )}
      <button type="submit" disabled={busy || (asBlock ? bStart === null || bEnd === null : slots === null)} className={primary}>{busy ? "Saving…" : asBlock ? "Block this time" : "Add booking"}</button>
      {asBlock
        ? <button type="button" disabled={busy} onClick={() => setAsBlock(false)} className={backLink}>Back to booking</button>
        : <button type="button" disabled={busy} onClick={() => setAsBlock(true)} className={secondary}>Block this time instead</button>}
    </form>
  );
}

function BookingSheet({ club, courts, booking: b, times, busy, onMove, onCancel, onNoShow }: {
  club: Club; courts: Court[]; booking: Booking; times: string[]; busy: boolean;
  onMove: (courtId: string, time: string, slots: number, price: number) => void;
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
  const quote = useMoveQuote(mode === "move" && slots !== null ? { booking: b, club, courtId, time, slots } : null);
  const [agreed, setAgreed] = useState(false);
  const priceChanges = quote.state === "ready" && quote.kind !== "same";
  const canSave = quote.state === "ready" && quote.kind !== "refused" && (quote.kind !== "agreement" || agreed);

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
              {(settlement(b) === "awaiting" || settlement(b) === "paid_in_app") && ` + $${Number(b.fee_usd ?? 0).toFixed(2)} fee`}
              {(settlement(b) === "fee_awaiting" || settlement(b) === "fee_paid") && ` (+ $${Number(b.fee_usd ?? 0).toFixed(2)} CourtBook fee online)`}
              {` · ${SETTLEMENT_TEXT[settlement(b)]}`}
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
          <MovePrice quote={quote} agreed={agreed} setAgreed={setAgreed} />
          <button disabled={busy || slots === null || !canSave} onClick={() => slots !== null && quote.state === "ready" && onMove(courtId, time, slots, quote.next)} className={primary}>
            {busy ? "Saving…" : priceChanges ? `Save move · new price $${quote.state === "ready" ? quote.next.toFixed(2) : ""}` : "Save move"}
          </button>
          <button disabled={busy} onClick={() => setMode("view")} className={backLink}>Back</button>
        </>
      )}

      {mode === "cancel" && (
        <>
          {settlement(b) === "fee_paid" && (
            <label className="flex items-start gap-3 rounded-xl bg-paper p-3 text-sm">
              <input type="checkbox" checked={clubCaused} onChange={(e) => setClubCaused(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>The club is cancelling (rain, maintenance, court closed, our mistake): CourtBook refunds the player&apos;s ${Number(b.fee_usd ?? 0).toFixed(2)} booking fee. Leave unticked if the player asked to cancel: the fee is then kept.</span>
            </label>
          )}
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

type MoveQuote = { state: "idle" | "loading" | "failed" } | { state: "ready"; current: number; next: number; kind: "same" | "reprice" | "agreement" | "refused" };

/** 0091: what the move does to the price, asked from the database (quote_move) whenever court, time or length change. */
function useMoveQuote(q: { booking: Booking; club: Club; courtId: string; time: string; slots: number } | null): MoveQuote {
  const [res, setRes] = useState<{ key: string; quote: MoveQuote } | null>(null);
  const key = q ? `${q.booking.id}|${q.courtId}|${q.time}|${q.slots}` : "";
  useEffect(() => {
    if (!q) return;
    let alive = true;
    const { start, end } = moveTarget(q.booking.start_at, q.club.timezone, q.time, q.slots, q.club.slot_minutes);
    Promise.resolve(createClient().rpc("quote_move", { p_booking: q.booking.id, p_court: q.courtId, p_start: start.toISOString(), p_end: end.toISOString() }))
      .then(({ data, error }) => {
        if (!alive) return;
        const d = data as { current: number | string; new: number | string; kind: string } | null;
        setRes({ key, quote: error || !d ? { state: "failed" } : { state: "ready", current: Number(d.current), next: Number(d.new), kind: d.kind as "same" } });
      }, () => { if (alive) setRes({ key, quote: { state: "failed" } }); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!q) return { state: "idle" };
  return res?.key === key ? res.quote : { state: "loading" };
}

function MovePrice({ quote, agreed, setAgreed }: { quote: MoveQuote; agreed: boolean; setAgreed: (v: boolean) => void }) {
  if (quote.state === "loading") return <p className="text-sm text-muted" role="status">Checking the price…</p>;
  if (quote.state === "failed") return <p className="text-sm text-danger" role="alert">Couldn&apos;t check the price for this change. Try again.</p>;
  if (quote.state !== "ready") return null;
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (quote.kind === "same") return <p className="text-sm text-muted" role="status">Price unchanged: {money(quote.current)}</p>;
  if (quote.kind === "refused") return (
    <p className="rounded-xl bg-sand-soft p-3 text-sm" role="alert">
      This booking was paid in the app, so its length can&apos;t change. Move it at the same length, or cancel it (the refund
      follows the club&apos;s rules) and book the new length.
    </p>
  );
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-sand-soft p-3 text-sm" role="status">
      <p>Price changes from <b>{money(quote.current)}</b> to <b>{money(quote.next)}</b>.</p>
      {quote.kind === "agreement" && (
        <label className="flex items-start gap-3">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>The player agreed to pay {money(quote.next)} at the desk for the new length.</span>
        </label>
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
    <form className="flex flex-col gap-3" onKeyDown={noEnterSubmit} onSubmit={(e) => { e.preventDefault(); onClose(from, to, reason.trim()); }}>
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
