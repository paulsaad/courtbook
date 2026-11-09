"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { clubLocalToUtc, hhmm, prettyDate, shiftDate, slotTimes, todayIn, toMin } from "@/lib/time";
import { friendlyError, type Block, type Booking, type Club, type Court } from "@/lib/types";

type Props = { club: Club; courts: Court[]; bookings: Booking[]; blocks: Block[]; date: string; view: "grid" | "list" };

type Sheet =
  | { kind: "add"; courtId: string; time: string }
  | { kind: "booking"; booking: Booking }
  | { kind: "block"; block: Block }
  | { kind: "close" }
  | null;

export default function DayCalendar({ club, courts, bookings, blocks, date, view }: Props) {
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const times = slotTimes(club.open_time, club.close_time, club.slot_minutes);
  const isToday = date === todayIn(club.timezone);

  function occupying(courtId: string, time: string) {
    const slotStart = clubLocalToUtc(date, time, club.timezone).getTime();
    const slotEnd = slotStart + club.slot_minutes * 60000;
    const b = bookings.find((x) => x.court_id === courtId && new Date(x.start_at).getTime() < slotEnd && new Date(x.end_at).getTime() > slotStart);
    if (b) return { booking: b, first: new Date(b.start_at).getTime() >= slotStart };
    const k = blocks.find((x) => x.court_id === courtId && new Date(x.start_at).getTime() < slotEnd && new Date(x.end_at).getTime() > slotStart);
    if (k) return { block: k, first: new Date(k.start_at).getTime() >= slotStart };
    return null;
  }

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) {
      setError(friendlyError(error.message));
      return false;
    }
    setSheet(null);
    router.refresh();
    return true;
  }

  const nav = (d: string) => `/staff/${club.slug}?date=${d}&view=${view}`;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b bg-white px-3 py-2">
        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-gray-500">‹ Home</Link>
          <span className="font-medium">{club.name}</span>
          <button onClick={() => setSheet({ kind: "close" })} className="text-sm text-red-700">Close day</button>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <Link href={nav(shiftDate(date, -1))} className="rounded-lg border px-3 py-1.5">‹</Link>
          <div className="text-center">
            <div className="font-medium">{prettyDate(date)}</div>
            {!isToday && <Link href={nav(todayIn(club.timezone))} className="text-xs text-blue-700 underline">Today</Link>}
          </div>
          <Link href={nav(shiftDate(date, 1))} className="rounded-lg border px-3 py-1.5">›</Link>
        </div>
        <div className="mt-2 flex gap-1 text-sm">
          <Link href={`/staff/${club.slug}?date=${date}&view=grid`} className={`flex-1 rounded-lg py-1 text-center ${view === "grid" ? "bg-black text-white" : "border"}`}>Grid</Link>
          <Link href={`/staff/${club.slug}?date=${date}&view=list`} className={`flex-1 rounded-lg py-1 text-center ${view === "list" ? "bg-black text-white" : "border"}`}>List</Link>
        </div>
      </header>

      {view === "grid" ? (
        <div className="flex-1 overflow-auto">
          <table className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-10 w-12 bg-white"></th>
                {courts.map((c) => (
                  <th key={c.id} className="sticky top-0 min-w-28 border-b border-l bg-white px-1 py-2 font-medium">
                    {c.name}
                    <div className="font-normal text-gray-500">{c.sport}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t) => (
                <tr key={t}>
                  <td className="sticky left-0 z-10 w-12 border-b bg-white pr-1 text-right align-top text-gray-500">{t}</td>
                  {courts.map((c) => {
                    const occ = occupying(c.id, t);
                    if (!occ) {
                      return (
                        <td key={c.id} className="h-14 border-b border-l">
                          <button onClick={() => setSheet({ kind: "add", courtId: c.id, time: t })} className="h-full w-full active:bg-gray-100" aria-label={`Add booking ${c.name} ${t}`} />
                        </td>
                      );
                    }
                    if (occ.booking) {
                      const b = occ.booking;
                      return (
                        <td key={c.id} className="h-14 border-b border-l p-0.5">
                          <button onClick={() => setSheet({ kind: "booking", booking: b })} className={`h-full w-full rounded px-1 text-left ${b.source === "app" ? "bg-blue-100" : "bg-amber-100"}`}>
                            {occ.first ? (
                              <>
                                <div className="truncate font-medium">{b.guest_name ?? b.player_name ?? "Player"}</div>
                                <div className="text-gray-600">{hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)}</div>
                              </>
                            ) : (
                              <div className="text-gray-500">…</div>
                            )}
                          </button>
                        </td>
                      );
                    }
                    const k = occ.block!;
                    return (
                      <td key={c.id} className="h-14 border-b border-l p-0.5">
                        <button onClick={() => setSheet({ kind: "block", block: k })} className="h-full w-full rounded bg-gray-200 px-1 text-left text-gray-700">
                          {occ.first ? k.reason ?? "Blocked" : "…"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="divide-y">
          {bookings.length === 0 && <li className="p-6 text-center text-gray-500">No bookings.</li>}
          {bookings.map((b) => (
            <li key={b.id}>
              <button onClick={() => setSheet({ kind: "booking", booking: b })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                <div className="w-24 shrink-0 text-sm">
                  <div className="font-medium">{hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)}</div>
                  <div className="text-gray-500">{courts.find((c) => c.id === b.court_id)?.name}</div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{b.guest_name ?? b.player_name ?? "Player"}</div>
                  {b.guest_phone && <div className="text-sm text-gray-600">{b.guest_phone}</div>}
                </div>
                <span className={`rounded px-2 py-0.5 text-xs ${b.source === "app" ? "bg-blue-100" : "bg-amber-100"}`}>{b.source === "app" ? "app" : "desk"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {sheet && (
        <div className="fixed inset-0 z-20 flex items-end bg-black/30" onClick={() => !busy && setSheet(null)}>
          <div className="w-full rounded-t-2xl bg-white p-4 pb-8 shadow-lg" onClick={(e) => e.stopPropagation()}>
            {error && <p className="mb-3 rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

            {sheet.kind === "add" && (
              <AddSheet
                club={club} court={courts.find((c) => c.id === sheet.courtId)!} date={date} time={sheet.time} times={times} busy={busy}
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
                club={club} courts={courts} booking={sheet.booking} date={date} times={times} busy={busy}
                onMove={(courtId, time, slots) =>
                  run(async () => {
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
                <h2 className="text-lg font-medium">Blocked: {sheet.block.reason ?? "—"}</h2>
                <p className="text-sm text-gray-600">{hhmm(sheet.block.start_at, club.timezone)}–{hhmm(sheet.block.end_at, club.timezone)} · {courts.find((c) => c.id === sheet.block.court_id)?.name}</p>
                <button disabled={busy} onClick={() => run(() => createClient().from("blocks").delete().eq("id", sheet.block.id))} className="rounded-lg border border-red-300 py-3 text-red-700">Remove block</button>
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

const input = "rounded-lg border px-3 py-3 text-base";
const primary = "rounded-lg bg-black py-3 text-base font-medium text-white disabled:opacity-50";

function AddSheet({ club, court, date, time, times, busy, onSave }: {
  club: Club; court: Court; date: string; time: string; times: string[]; busy: boolean;
  onSave: (name: string, phone: string, slots: number, asBlock: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [slots, setSlots] = useState(1);
  const remaining = times.length - times.indexOf(time);
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onSave(name.trim(), phone.trim(), slots, false); }}>
      <h2 className="text-lg font-medium">{court.name} · {prettyDate(date)} {time}</h2>
      <input className={input} placeholder="Name" required value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      <input className={input} placeholder="Phone (optional)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      <label className="flex items-center justify-between text-sm">
        Duration
        <select className="rounded-lg border px-3 py-2" value={slots} onChange={(e) => setSlots(Number(e.target.value))}>
          {Array.from({ length: Math.min(4, remaining) }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n * club.slot_minutes} min</option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy} className={primary}>Add booking</button>
      <button type="button" disabled={busy} onClick={() => onSave(name.trim(), "", slots, true)} className="rounded-lg border py-3 text-base">Block instead</button>
    </form>
  );
}

function BookingSheet({ club, courts, booking: b, date, times, busy, onMove, onCancel, onNoShow }: {
  club: Club; courts: Court[]; booking: Booking; date: string; times: string[]; busy: boolean;
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

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-medium">{b.guest_name ?? b.player_name ?? "Player"}</h2>
        <p className="text-sm text-gray-600">
          {court?.name} · {prettyDate(date)} {hhmm(b.start_at, club.timezone)}–{hhmm(b.end_at, club.timezone)} · {b.source === "app" ? "booked in app" : "desk booking"}
        </p>
        {b.guest_phone && <a href={`tel:${b.guest_phone}`} className="text-sm text-blue-700 underline">{b.guest_phone}</a>}
      </div>

      {mode === "view" && (
        <>
          <button disabled={busy} onClick={() => setMode("move")} className="rounded-lg border py-3">Move</button>
          {started && <button disabled={busy} onClick={onNoShow} className="rounded-lg border py-3">Mark no-show</button>}
          <button disabled={busy} onClick={() => setMode("cancel")} className="rounded-lg border border-red-300 py-3 text-red-700">Cancel booking</button>
        </>
      )}

      {mode === "move" && (
        <>
          <label className="flex items-center justify-between text-sm">Court
            <select className="rounded-lg border px-3 py-2" value={courtId} onChange={(e) => setCourtId(e.target.value)}>
              {courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between text-sm">Start
            <select className="rounded-lg border px-3 py-2" value={time} onChange={(e) => setTime(e.target.value)}>
              {times.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between text-sm">Duration
            <select className="rounded-lg border px-3 py-2" value={slots} onChange={(e) => setSlots(Number(e.target.value))}>
              {[1, 2, 3, 4].filter((n) => toMin(time) + n * club.slot_minutes <= toMin(club.close_time === "24:00:00" ? "24:00" : club.close_time)).map((n) => (
                <option key={n} value={n}>{n * club.slot_minutes} min</option>
              ))}
            </select>
          </label>
          <button disabled={busy} onClick={() => onMove(courtId, time, slots)} className={primary}>Save move</button>
          <button disabled={busy} onClick={() => setMode("view")} className="py-2 text-sm text-gray-600">Back</button>
        </>
      )}

      {mode === "cancel" && (
        <>
          {b.source === "app" && b.credit_tx_id && (
            <label className="flex items-start gap-2 rounded-lg bg-gray-50 p-3 text-sm">
              <input type="checkbox" checked={clubCaused} onChange={(e) => setClubCaused(e.target.checked)} className="mt-1" />
              <span>Club-caused (rain, maintenance, our mistake) — refund the player&apos;s credit even inside the {club.cancel_cutoff_hours}h cutoff.</span>
            </label>
          )}
          <button disabled={busy} onClick={() => onCancel(clubCaused)} className="rounded-lg bg-red-700 py-3 font-medium text-white disabled:opacity-50">Confirm cancellation</button>
          <button disabled={busy} onClick={() => setMode("view")} className="py-2 text-sm text-gray-600">Back</button>
        </>
      )}
    </div>
  );
}

function CloseSheet({ club, times, busy, onClose }: { club: Club; times: string[]; busy: boolean; onClose: (from: string, to: string, reason: string) => void }) {
  const closeT = club.close_time === "24:00:00" ? "24:00" : club.close_time.slice(0, 5);
  const [from, setFrom] = useState(times[0]);
  const [to, setTo] = useState(closeT);
  const [reason, setReason] = useState("");
  const ends = [...times.slice(1), closeT];
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); onClose(from, to, reason.trim()); }}>
      <h2 className="text-lg font-medium">Close all courts</h2>
      <p className="text-sm text-gray-600">Blocks every court for the range. Refused if any booking exists in it — cancel or move those first.</p>
      <div className="flex gap-2">
        <label className="flex flex-1 flex-col text-sm">From
          <select className="rounded-lg border px-3 py-2" value={from} onChange={(e) => setFrom(e.target.value)}>{times.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
        <label className="flex flex-1 flex-col text-sm">To
          <select className="rounded-lg border px-3 py-2" value={to} onChange={(e) => setTo(e.target.value)}>{ends.filter((t) => toMin(t) > toMin(from)).map((t) => <option key={t}>{t}</option>)}</select>
        </label>
      </div>
      <input className={input} placeholder="Reason (holiday, tournament…)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="submit" disabled={busy} className="rounded-lg bg-red-700 py-3 font-medium text-white disabled:opacity-50">Close courts</button>
    </form>
  );
}
