"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { parseISO } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { clubLocalToUtc, dayBounds, hhmm, shiftDate, slotTimes, todayIn, toMin } from "@/lib/time";
import { friendlyError, type Block, type Booking, type Club, type Court } from "@/lib/types";

type Props = { club: Club; courts: Court[]; bookings: Booking[]; blocks: Block[]; date: string; view: "grid" | "list" };

type Sheet =
  | { kind: "add"; courtId: string; time: string }
  | { kind: "booking"; booking: Booking }
  | { kind: "block"; block: Block }
  | { kind: "close" }
  | null;


export default function DayCalendar({ club, courts, bookings: initialBookings, blocks: initialBlocks, date, view }: Props) {
  const [bookings, setBookings] = useState(initialBookings);
  const [blocks, setBlocks] = useState(initialBlocks);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nowMin, setNowMin] = useState<number | null>(null);

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
    const supabase = createClient();
    const { dayStart, dayEnd } = dayBounds(date, club.timezone);
    const [{ data: b }, { data: k }] = await Promise.all([
      supabase.from("bookings").select("id, court_id, player_id, guest_name, guest_phone, start_at, end_at, status, source, credit_tx_id")
        .eq("club_id", club.id).or(`status.eq.confirmed,and(status.eq.pending,hold_expires_at.gt.${new Date().toISOString()})`).not("court_id", "is", null).lt("start_at", dayEnd).gt("end_at", dayStart).order("start_at"),
      supabase.from("blocks").select("id, court_id, start_at, end_at, reason").eq("club_id", club.id).lt("start_at", dayEnd).gt("end_at", dayStart),
    ]);
    const ids = [...new Set((b ?? []).map((x) => x.player_id).filter(Boolean))] as string[];
    const names = new Map<string, string | null>();
    if (ids.length) {
      const { data } = await supabase.rpc("player_names", { p_ids: ids });
      (data as { id: string; name: string | null }[] | null)?.forEach((p) => names.set(p.id, p.name));
    }
    setBookings((b ?? []).map((x) => ({ ...x, player_name: x.player_id ? names.get(x.player_id) ?? null : null })) as Booking[]);
    setBlocks((k ?? []) as Block[]);
  }, [club.id, club.timezone, date]);

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

  const nav = (d: string) => `/staff/${club.slug}?date=${d}&view=${view}`;
  const dayNum = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "d");
  const dayName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "EEEE");
  const monthName = formatInTimeZone(clubLocalToUtc(date, "12:00", club.timezone), club.timezone, "MMMM yyyy");
  const courtName = (id: string | null) => courts.find((c) => c.id === id)?.name ?? "";

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col">
      <header className="sticky top-0 z-10 bg-paper/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 pt-3 text-sm">
          <Link href="/" className="text-muted">‹ {club.name}</Link>
          <div className="flex gap-4"><Link href={`/staff/${club.slug}/settings`} className="text-muted">Settings</Link><button onClick={() => setSheet({ kind: "close" })} className="text-danger">Close courts…</button></div>
        </div>
        <div className="flex items-end justify-between px-4 pb-3 pt-1">
          <div className="flex items-end gap-3">
            <span className="text-5xl font-semibold leading-none tracking-tight">{dayNum}</span>
            <div className="pb-0.5 leading-tight">
              <div className="font-medium">{dayName}</div>
              <div className="text-sm text-muted">{monthName}</div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link href={nav(shiftDate(date, -1))} aria-label="Previous day" className="grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg">‹</Link>
            <Link href={nav(todayIn(club.timezone))} className={`h-10 rounded-full px-3 text-sm leading-10 ${isToday ? "text-muted" : "border border-grid bg-white"}`}>Today</Link>
            <Link href={nav(shiftDate(date, 1))} aria-label="Next day" className="grid h-10 w-10 place-items-center rounded-full border border-grid bg-white text-lg">›</Link>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 pb-2">
          <div className="flex rounded-full border border-grid bg-white p-0.5 text-sm">
            <Link href={`/staff/${club.slug}?date=${date}&view=grid`} className={`rounded-full px-4 py-1.5 ${view === "grid" ? "bg-ink text-white" : ""}`}>Courts</Link>
            <Link href={`/staff/${club.slug}?date=${date}&view=list`} className={`rounded-full px-4 py-1.5 ${view === "list" ? "bg-ink text-white" : ""}`}>List</Link>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-turf" />app</span>
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-sand" />desk</span>
          </div>
        </div>
      </header>

      {view === "grid" ? (
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
                  <div className="text-xs text-muted">{c.sport}</div>
                </div>
              ))}
              {courts.map((c) => (
                <div key={c.id} className="relative rounded-lg border border-grid bg-white" style={{ height: times.length * ROW_PX }}>
                  {/* empty slots */}
                  {times.map((t, i) => (
                    <button
                      key={t}
                      onClick={() => setSheet({ kind: "add", courtId: c.id, time: t })}
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
          {bookings.length === 0 && <li className="p-8 text-center text-muted">No bookings this day. Tap a court slot in Courts view to add one.</li>}
          {bookings.map((b) => (
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
                club={club} court={courts.find((c) => c.id === sheet.courtId)!} time={sheet.time} times={times} busy={busy}
                onSave={(name, phone, slots, asBlock) =>
                  run(async () => {
                    const supabase = createClient();
                    const start = clubLocalToUtc(date, sheet.time, club.timezone);
                    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
                    const { data: { user } } = await supabase.auth.getUser();
                    if (asBlock) {
                      return supabase.from("blocks").insert({ club_id: club.id, court_id: sheet.courtId, start_at: start.toISOString(), end_at: end.toISOString(), reason: name || "Blocked", created_by: user!.id });
                    }
                    return supabase.from("bookings").insert({ club_id: club.id, court_id: sheet.courtId, guest_name: name, guest_phone: phone || null, start_at: start.toISOString(), end_at: end.toISOString(), source: "staff", created_by: user!.id });
                  })
                }
              />
            )}

            {sheet.kind === "booking" && (
              <BookingSheet
                club={club} courts={courts} booking={sheet.booking} times={times} busy={busy}
                onMove={(courtId, time, slots) =>
                  run(() => {
                    const start = clubLocalToUtc(date, time, club.timezone);
                    const end = new Date(start.getTime() + slots * club.slot_minutes * 60000);
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

function AddSheet({ club, court, time, times, busy, onSave }: {
  club: Club; court: Court; time: string; times: string[]; busy: boolean;
  onSave: (name: string, phone: string, slots: number, asBlock: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const remaining = times.length - times.indexOf(time);
  const [slots, setSlots] = useState(Math.min(remaining, Math.max(1, Math.round(club.min_booking_minutes / club.slot_minutes))));
  const endTime = (n: number) => {
    const m = toMin(time) + n * club.slot_minutes;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onSave(name.trim(), phone.trim(), slots, false); }}>
      <h2 className="text-lg font-semibold">{court.name}, {time}–{endTime(slots)}</h2>
      <input className={input} placeholder="Name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className={input} placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: Math.min(Math.floor(240 / club.slot_minutes), remaining) }, (_, i) => i + 1).map((n) => (
          <button type="button" key={n} onClick={() => setSlots(n)} className={`rounded-xl border py-2 text-sm ${slots === n ? "border-ink bg-ink text-white" : "border-grid"}`}>
            {fmtDur(n * club.slot_minutes)}
          </button>
        ))}
      </div>
      <button type="submit" disabled={busy} className={primary}>{busy ? "Saving…" : "Add booking"}</button>
      <button type="button" disabled={busy} onClick={() => onSave(name.trim(), "", slots, true)} className={secondary}>Block this time instead</button>
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
  const [slots, setSlots] = useState(curSlots);
  const [clubCaused, setClubCaused] = useState(false);
  const [started] = useState(() => new Date(b.start_at).getTime() <= Date.now());
  const court = courts.find((c) => c.id === b.court_id);
  const closeMin = closeMinutes(club);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{b.guest_name ?? b.player_name ?? "Player"}</h2>
        <p className="text-sm text-muted">
          {court?.name}, {hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)} · {b.source === "app" ? "booked in the app" : "desk booking"}
        </p>
        {b.guest_phone && <a href={`tel:${b.guest_phone}`} className="text-sm text-action underline">{b.guest_phone}</a>}
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
            <select className={select} value={slots} onChange={(e) => setSlots(Number(e.target.value))}>
              {Array.from({ length: Math.floor(240 / club.slot_minutes) }, (_, i) => i + 1).filter((n) => toMin(time) + n * club.slot_minutes <= closeMin).map((n) => (
                <option key={n} value={n}>{fmtDur(n * club.slot_minutes)}</option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => onMove(courtId, time, slots)} className={primary}>{busy ? "Saving…" : "Save move"}</button>
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
