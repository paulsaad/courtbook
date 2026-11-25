"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import ClubReadiness, { type ReadinessRow } from "./ClubReadiness";
import ClubPhotos from "@/components/ClubPhotos";
import ClubVenue, { type VenueRow } from "@/components/ClubVenue";
import type { ClubMedia } from "@/lib/media";
import { friendlyError } from "@/lib/types";
import { clubPoint, linkWithoutPoint, pointFromMapLink } from "@/lib/places";
import type { Governorate, Sport, Town, TownWithArea } from "@/lib/geo";

type ClubRow = {
  id: string; name: string; slug: string; active: boolean; timezone: string; location_url: string | null;
  open_time: string; close_time: string; slot_minutes: number; min_booking_minutes: number; max_booking_minutes: number;
  cancel_cutoff_hours: number; hold_minutes: number; booking_window_days: number; service_fee_usd: number;
  town_id: string | null; lat: number | null; lng: number | null;
  payment_mode?: string | null; max_upcoming_bookings?: number | null;
};
type CourtRow = { id: string; name: string; sport: string; surface: string | null; active: boolean; sort: number };
type RuleRow = { id: string; court_id: string | null; weekday_mask: number; start_time: string; end_time: string; price_usd: number; label: string | null };
type StaffRow = { profile_id: string; name: string | null; email: string };
type CoachReq = { coach_id: string; name: string | null; sports: string[]; price_usd: number; status: string };

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
// min-h-11 on phones: a select's height comes from the font, and Linux Chrome renders these at 43 px (GitHub, W1).
const input = "min-h-11 min-w-0 rounded-xl border border-grid bg-white px-3 py-2.5 text-base outline-none focus:border-action sm:min-h-0";
/** Text buttons in lists: a 44 px tap height on phones (W1), unchanged from 640 px. */
const textBtn = "inline-flex min-h-11 items-center px-1 underline sm:min-h-0 sm:px-0";
const primary = "rounded-xl bg-action px-4 py-2.5 font-medium text-white disabled:opacity-50";
const hhmm = (t: string) => t.slice(0, 5);
const section = "flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4";

export default function ClubSettings({ club, courts, rules, staff, coaches, isAdmin, backHref, areas, sports, town, media, readiness }: { club: ClubRow; courts: CourtRow[]; rules: RuleRow[]; staff: StaffRow[]; coaches: CoachReq[]; isAdmin: boolean; backHref: string; areas: Governorate[]; sports: Sport[]; town: TownWithArea | null; media: ClubMedia[]; readiness?: ReadinessRow[] | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) {
    setBusy(true); setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return false; }
    after?.();
    router.refresh();
    return true;
  }

  const [f, setF] = useState<Settings>({
    open: hhmm(club.open_time), close: club.close_time.startsWith("24") ? "24:00" : hhmm(club.close_time),
    slot: club.slot_minutes, min: club.min_booking_minutes, max: club.max_booking_minutes,
    cutoff: club.cancel_cutoff_hours, hold: club.hold_minutes, window: club.booking_window_days, location: club.location_url ?? "",
    town: club.town_id, lat: club.lat == null ? "" : String(club.lat), lng: club.lng == null ? "" : String(club.lng),
  });
  const save = () => run(() => createClient().rpc("update_club_settings", {
    p_club: club.id, p_open: f.open, p_close: f.close === "24:00" ? "24:00:00" : f.close, p_slot: f.slot, p_min: f.min, p_max: f.max,
    p_cutoff: f.cutoff, p_hold: f.hold, p_window: f.window, p_location: f.location,
    p_town: f.town, p_lat: f.lat.trim() === "" ? null : Number(f.lat), p_lng: f.lng.trim() === "" ? null : Number(f.lng),
  }));

  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-5 p-5 pb-16">
      <Link href={backHref} className="inline-flex min-h-11 items-center text-sm text-muted sm:min-h-0">‹ Back</Link>
      <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

      {readiness && <ClubReadiness clubId={club.id} active={club.active} rows={readiness} isAdmin={isAdmin} />}
      {isAdmin && <AdminBasics club={club} busy={busy} run={run} hasChecklist={!!readiness} />}
      <ClubPhotos clubId={club.id} initial={media} />
      <ClubVenue club={club as unknown as VenueRow} />
      <Location f={f} setF={setF} areas={areas} town={town} busy={busy} save={save} />
      {readiness && <Contact club={club} busy={busy} run={run} />}
      <Hours f={f} setF={setF} busy={busy} save={save} />
      <Courts clubId={club.id} courts={courts} sports={sports} busy={busy} run={run} />
      <Prices clubId={club.id} courts={courts} rules={rules} busy={busy} run={run} open={f.open} close={f.close} />
      <Coaches clubId={club.id} coaches={coaches} busy={busy} run={run} />
      {isAdmin && <Staff clubId={club.id} staff={staff} busy={busy} run={run} />}
    </main>
  );
}

type Run = (fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) => Promise<boolean>;
type Settings = { open: string; close: string; slot: number; min: number; max: number; cutoff: number; hold: number; window: number; location: string; town: string | null; lat: string; lng: string };
type SetF = (f: Settings) => void;

function Contact({ club, busy, run }: { club: ClubRow; busy: boolean; run: Run }) {
  const c = club as unknown as { contact_phone?: string | null; contact_email?: string | null };
  const [phone, setPhone] = useState(c.contact_phone ?? "");
  const [email, setEmail] = useState(c.contact_email ?? "");
  return (
    <section className={section}>
      <h2 className="font-medium">Contact</h2>
      <p className="text-xs text-muted">Shown to players on the club&apos;s page. A phone number is required before the club can be published.</p>
      <label className="flex flex-col gap-1 text-sm">Phone<input className={input} inputMode="tel" autoComplete="off" value={phone} placeholder="+961 6 123 456" onChange={(e) => setPhone(e.target.value)} /></label>
      <label className="flex flex-col gap-1 text-sm">Email (optional)<input className={input} inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <button disabled={busy} onClick={() => run(() => createClient().rpc("set_club_contact", { p_club: club.id, p_phone: phone, p_email: email }))} className={primary}>Save contact</button>
    </section>
  );
}

function AdminBasics({ club, busy, run, hasChecklist }: { club: ClubRow; busy: boolean; run: Run; hasChecklist: boolean }) {
  const [name, setName] = useState(club.name);
  const [fee, setFee] = useState(String(club.service_fee_usd));
  const [active, setActive] = useState(club.active);
  const [mode, setMode] = useState(club.payment_mode ?? "simulated");
  const [cap, setCap] = useState(String(club.max_upcoming_bookings ?? 3));
  return (
    <section className={section}>
      <h2 className="font-medium">Club (admin)</h2>
      <label className="flex flex-col gap-1 text-sm">Name<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="flex flex-col gap-1 text-sm">CourtBook fee per booking ($)<input className={input} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
      {/* with the checklist (0081), visibility is set by Publish / Hide at the top of the page */}
      {!hasChecklist && <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-0"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Visible to players</label>}
      <button disabled={busy} onClick={() => run(() => !/^\d{1,4}(\.\d{1,2})?$/.test(fee.trim())
        ? Promise.resolve({ error: { message: "bad_fee" } })   // whole cents only (the database also refuses finer values: 0096)
        : createClient().from("clubs").update(hasChecklist ? { name: name.trim(), service_fee_usd: Number(fee) } : { name: name.trim(), service_fee_usd: Number(fee), active }).eq("id", club.id))} className={primary}>Save</button>

      <div className="mt-2 border-t border-grid pt-3">
        <h3 className="text-sm font-medium">How this club takes money</h3>
        <p className="mt-1 text-xs text-muted">
          <b>At the desk</b>: players reserve and it is confirmed at once; nothing is paid through CourtBook, and the
          in-app payment flow is refused for this club. <b>In the app</b>: the slot is held while the player pays.
          <b>Court at the desk, booking fee online</b>: the club takes the court price at its desk; the player pays only
          CourtBook&apos;s booking fee in the app (kept if the player cancels, refunded by CourtBook if the club cancels). A
          real club can use it only once a payment provider is connected. Changing the mode releases any hold a player is
          part-way through paying for.
        </p>
        <label className="mt-2 flex flex-col gap-1 text-sm">Payment
          <select className={input} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="simulated">In the app (simulated until a real provider is connected)</option>
            <option value="at_desk">At the club&apos;s desk</option>
            <option value="fee_online">Court at the desk, booking fee online</option>
          </select>
        </label>
        <label className="mt-2 flex flex-col gap-1 text-sm">Most bookings one player may hold at once
          <input className={input} inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <button disabled={busy} onClick={() => run(async () => {
          const supabase = createClient();
          const { error } = await supabase.rpc("set_club_payment_mode", { p_club: club.id, p_mode: mode });
          if (error) return { error };
          return supabase.from("clubs").update({ max_upcoming_bookings: Number(cap) }).eq("id", club.id);
        })} className={primary}>Save payment settings</button>
      </div>
    </section>
  );
}

function Hours({ f, setF, busy, save }: { f: Settings; setF: SetF; busy: boolean; save: () => Promise<boolean> }) {
  const set = (k: keyof Settings, v: string | number) => setF({ ...f, [k]: v });
  const num = (k: "slot" | "min" | "max" | "cutoff" | "hold" | "window", label: string, opts?: number[]) => (
    <label className="flex items-center justify-between gap-3 text-sm">{label}
      {opts ? (
        <select className={input} value={f[k]} onChange={(e) => set(k, Number(e.target.value))}>{opts.map((o) => <option key={o} value={o}>{o}</option>)}</select>
      ) : (
        <input className={`${input} w-24 text-right`} inputMode="numeric" value={f[k]} onChange={(e) => set(k, Number(e.target.value))} />
      )}
    </label>
  );
  return (
    <section className={section}>
      <h2 className="font-medium">Hours and booking rules</h2>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">Opens<input className={input} type="time" step={1800} value={f.open} onChange={(e) => set("open", e.target.value)} /></label>
        <label className="flex flex-1 flex-col gap-1 text-sm">Closes<input className={input} type="time" step={1800} value={f.close === "24:00" ? "23:59" : f.close} onChange={(e) => set("close", e.target.value === "23:59" ? "24:00" : e.target.value)} /></label>
      </div>
      {num("slot", "Grid step (minutes)", [30, 60, 90])}
      {num("min", "Players book at least (min)")}
      {num("max", "Players book at most (min)")}
      {num("cutoff", "Free cancellation until (hours before)")}
      {num("hold", "Payment hold (minutes)")}
      {num("window", "Players can book ahead (days)")}
      <p className="text-xs text-muted">Min/max must be multiples of the grid step. 23:59 means midnight.</p>
      <button disabled={busy} onClick={save} className={primary}>Save</button>
    </section>
  );
}

function Location({ f, setF, areas, town, busy, save }: { f: Settings; setF: SetF; areas: Governorate[]; town: TownWithArea | null; busy: boolean; save: () => Promise<boolean> }) {
  const [gov, setGov] = useState(town?.governorate_code ?? "");
  const [district, setDistrict] = useState(town?.district_code ?? "");
  const [towns, setTowns] = useState<Town[]>(town ? [{ id: town.id, district_code: town.district_code, name_en: town.name_en, name_ar: town.name_ar }] : []);
  const [newTown, setNewTown] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const districts = areas.find((g) => g.code === gov)?.districts ?? [];

  async function loadTowns(d: string) {
    const { data } = await createClient().from("towns").select("id, district_code, name_en, name_ar").eq("district_code", d).order("name_en");
    setTowns((data ?? []) as Town[]);
  }
  function pickGov(code: string) { setGov(code); setDistrict(""); setTowns([]); setF({ ...f, town: null }); }
  function pickDistrict(code: string) { setDistrict(code); setF({ ...f, town: null }); if (code) loadTowns(code); else setTowns([]); }
  async function addTown() {
    setAdding(true); setAddError(null);
    const { data, error } = await createClient().rpc("add_town", { p_district: district, p_name_en: newTown.trim() });
    setAdding(false);
    if (error) { setAddError(friendlyError(error.message)); return; }
    await loadTowns(district);
    setF({ ...f, town: data as string }); setNewTown("");
  }

  return (
    <section className={section}>
      <h2 className="font-medium">Location</h2>
      <label className="flex flex-col gap-1 text-sm">Governorate
        <select className={input} value={gov} onChange={(e) => pickGov(e.target.value)}>
          <option value="">—</option>{areas.map((g) => <option key={g.code} value={g.code}>{g.name_en}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">District
        <select className={input} value={district} disabled={!gov} onChange={(e) => pickDistrict(e.target.value)}>
          <option value="">—</option>{districts.map((d) => <option key={d.code} value={d.code}>{d.name_en}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">Town
        <select className={input} value={f.town ?? ""} disabled={!district} onFocus={() => { if (district && towns.length <= 1) loadTowns(district); }} onChange={(e) => setF({ ...f, town: e.target.value || null })}>
          <option value="">—</option>{towns.map((t) => <option key={t.id} value={t.id}>{t.name_en}</option>)}
        </select>
      </label>
      {district && (
        <div className="flex gap-2">
          <input className={`${input} flex-1`} placeholder="Town missing? Type its name" value={newTown} onChange={(e) => setNewTown(e.target.value)} />
          <button type="button" disabled={adding || newTown.trim().length < 2} onClick={addTown} className="rounded-xl border border-grid px-4 disabled:opacity-50">Add</button>
        </div>
      )}
      {addError && <p className="text-xs text-danger">{addError}</p>}
      <div className="flex gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Latitude<input className={input} inputMode="decimal" placeholder="34.2553" value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} /></label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Longitude<input className={input} inputMode="decimal" placeholder="35.6586" value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} /></label>
      </div>
      <label className="flex flex-col gap-1 text-sm">Map link<input className={input} placeholder="https://maps.google.com/…" value={f.location}
        onChange={(e) => {
          // pasting the link of the exact spot fills the map point (staff correct a location without typing numbers)
          const p = pointFromMapLink(e.target.value);
          setF({ ...f, location: e.target.value, ...(p ? { lat: String(p.lat), lng: String(p.lng) } : {}) });
        }} /></label>
      <MapLinkNote link={f.location} hasPoint={f.lat.trim() !== "" && f.lng.trim() !== ""} />
      {(() => {
        const p = clubPoint(f.lat.trim() === "" ? null : f.lat, f.lng.trim() === "" ? null : f.lng);
        const half = (f.lat.trim() === "") !== (f.lng.trim() === "");
        return (
          <p className="text-xs text-muted">
            The exact map point is what players&apos; Directions and &ldquo;Near me&rdquo; use, and a club needs it to be published. Paste the Google Maps
            link of the entrance (long form, with the numbers) and the point fills in.{" "}
            {p ? <a className="inline-flex min-h-11 items-center font-semibold text-action underline" href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`} target="_blank" rel="noreferrer">Check the point on the map</a>
              : half ? <span className="text-danger">Enter both latitude and longitude, or neither.</span>
              : f.lat.trim() !== "" ? <span className="text-danger">That point is outside Lebanon.</span> : null}
          </p>
        );
      })()}
      <button disabled={busy} onClick={save} className={primary}>Save</button>
    </section>
  );
}

function Courts({ clubId, courts, sports, busy, run }: { clubId: string; courts: CourtRow[]; sports: Sport[]; busy: boolean; run: Run }) {
  const [name, setName] = useState("");
  const [confirmOff, setConfirmOff] = useState<string | null>(null);
  const [sport, setSport] = useState(sports[0]?.code ?? "other");
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;
  const [surface, setSurface] = useState("");
  return (
    <section className={section}>
      <h2 className="font-medium">Courts</h2>
      <ul className="divide-y divide-grid">
        {courts.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2 text-sm">
            <div><span className={c.active ? "" : "text-muted line-through"}>{c.name}</span> <span className="text-muted">· {sportName(c.sport)}{c.surface ? ` · ${c.surface}` : ""}</span></div>
            {c.active && confirmOff === c.id ? (
              <span className="flex items-center gap-3">
                <button disabled={busy} onClick={() => run(() => createClient().from("courts").update({ active: false }).eq("id", c.id), () => setConfirmOff(null))} className={`${textBtn} font-semibold text-danger`}>Deactivate {c.name}</button>
                <button disabled={busy} onClick={() => setConfirmOff(null)} className={textBtn}>Keep</button>
              </span>
            ) : (
              <button disabled={busy} onClick={() => (c.active ? setConfirmOff(c.id) : run(() => createClient().from("courts").update({ active: true }).eq("id", c.id)))} className={`${textBtn} text-action`}>{c.active ? "Deactivate" : "Activate"}</button>
            )}
          </li>
        ))}
      </ul>
      {confirmOff && (
        <p role="alert" className="rounded-xl bg-sand-soft p-3 text-sm">
          Players will no longer see this court, and it leaves the calendar. A court with upcoming bookings can&apos;t be
          deactivated: move or cancel them first.
        </p>
      )}
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("courts").insert({ club_id: clubId, name: name.trim(), sport, surface: surface.trim() || null, sort: courts.length + 1 }), () => { setName(""); setSurface(""); }); }}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input aria-label="Court name" className={`${input} flex-1`} placeholder="Court name" required value={name} onChange={(e) => setName(e.target.value)} />
          <select aria-label="Sport" className={input} value={sport} onChange={(e) => setSport(e.target.value)}>{sports.map((s) => <option key={s.code} value={s.code}>{s.name_en}</option>)}</select>
        </div>
        <input aria-label="Surface (optional)" className={input} placeholder="Surface (optional)" value={surface} onChange={(e) => setSurface(e.target.value)} />
        <button disabled={busy} className="rounded-xl border border-grid py-2.5">Add court</button>
      </form>
    </section>
  );
}

function Prices({ clubId, courts, rules, busy, run, open, close }: { clubId: string; courts: CourtRow[]; rules: RuleRow[]; busy: boolean; run: Run; open: string; close: string }) {
  const [f, setF] = useState({ label: "", start: "08:00", end: "17:00", price: "", court: "", mask: 127 });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const toggleDay = (i: number) => setF({ ...f, mask: f.mask ^ (1 << i) });
  const daysOf = (mask: number) => (mask === 127 ? "every day" : DAYS.filter((_, i) => mask & (1 << i)).join(" "));
  return (
    <section className={section}>
      <h2 className="font-medium">Prices (per hour)</h2>
      <p className="text-xs text-muted">Every bookable time must be covered by a rule. A court-specific rule beats a whole-club rule.</p>
      <ul className="divide-y divide-grid">
        {rules.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div>{hhmm(r.start_time)}–{hhmm(r.end_time)} · <b>${Number(r.price_usd).toFixed(2)}</b>/h {r.label && <span className="text-muted">· {r.label}</span>}</div>
              <div className="text-xs text-muted">{daysOf(r.weekday_mask)} · {r.court_id ? courts.find((c) => c.id === r.court_id)?.name : "all courts"}</div>
            </div>
            {confirmDelete === r.id ? (
              <span className="flex items-center gap-3">
                <button disabled={busy} onClick={() => run(() => createClient().from("price_rules").delete().eq("id", r.id), () => setConfirmDelete(null))} className={`${textBtn} font-semibold text-danger`}>Delete this price</button>
                <button disabled={busy} onClick={() => setConfirmDelete(null)} className={textBtn}>Keep</button>
              </span>
            ) : (
              <button disabled={busy} onClick={() => setConfirmDelete(r.id)} className={`${textBtn} text-danger`} aria-label={`Delete the price ${hhmm(r.start_time)}–${hhmm(r.end_time)}`}>Delete</button>
            )}
          </li>
        ))}
      </ul>
      {confirmDelete && (
        <p role="alert" className="rounded-xl bg-sand-soft p-3 text-sm">
          Deleting a price can leave times players cannot book (the checklist will say which). Bookings already made keep
          their price.
        </p>
      )}
      <OnePrice clubId={clubId} hasWholeClub={rules.some((r) => !r.court_id)} busy={busy} run={run} open={open} close={close} />
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("price_rules").insert({ club_id: clubId, court_id: f.court || null, weekday_mask: f.mask, start_time: f.start, end_time: f.end, price_usd: Number(f.price), label: f.label.trim() || null }), () => setF({ ...f, price: "", label: "" })); }}>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Price from" className={`${input} min-w-[8rem] flex-1`} type="time" step={1800} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          <input aria-label="Price until" className={`${input} min-w-[8rem] flex-1`} type="time" step={1800} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          <input aria-label="Price per hour in dollars" className={`${input} w-24`} inputMode="decimal" placeholder="$/h" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        </div>
        <div className="flex gap-1">
          {DAYS.map((d, i) => <button type="button" key={d} aria-label={DAY_NAMES[i]} aria-pressed={!!(f.mask & (1 << i))} onClick={() => toggleDay(i)} className={`min-h-11 flex-1 rounded-lg border py-1.5 text-xs sm:min-h-0 ${f.mask & (1 << i) ? "border-ink bg-ink text-white" : "border-grid"}`}>{d}</button>)}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <select aria-label="Which courts" className={`${input} flex-1`} value={f.court} onChange={(e) => setF({ ...f, court: e.target.value })}><option value="">All courts</option>{courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input aria-label="Label (optional)" className={`${input} flex-1`} placeholder="Label (peak…)" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </div>
        <button disabled={busy} className="rounded-xl border border-grid py-2.5">Add price rule</button>
      </form>
    </section>
  );
}

/** 0092: one price for all opening hours, with optional peak times; the database writes rules that never overlap.
 *  Existing whole-club prices are replaced only when the desk ticks it on purpose. */
export function OnePrice({ clubId, hasWholeClub, busy, run, open, close }: { clubId: string; hasWholeClub: boolean; busy: boolean; run: Run; open: string; close: string }) {
  const [base, setBase] = useState("");
  const [peaks, setPeaks] = useState<{ start: string; end: string; price: string; days: number }[]>([]);
  const [replace, setReplace] = useState(false);
  const DAY_SHORT = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const setPeak = (i: number, p: Partial<(typeof peaks)[number]>) => setPeaks(peaks.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <form className="flex flex-col gap-2 rounded-xl bg-paper p-3" aria-labelledby="one-price"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => createClient().rpc("set_club_base_prices", {
          p_club: clubId, p_base: Number(base), p_replace: replace,
          p_peaks: peaks.map((p) => ({ start: p.start, end: p.end, price: Number(p.price), days: p.days })),
        }), () => { setBase(""); setPeaks([]); setReplace(false); });
      }}>
      <h3 id="one-price" className="text-sm font-medium">Quick set-up: one price for all opening hours ({open}–{close})</h3>
      <label className="flex items-center justify-between gap-3 text-sm">Price per hour ($)
        <input className={`${input} w-24 text-right`} inputMode="decimal" required value={base} onChange={(e) => setBase(e.target.value)} />
      </label>
      {peaks.map((p, i) => (
        <fieldset key={i} className="flex flex-col gap-2 rounded-lg border border-grid p-2">
          <legend className="px-1 text-xs text-muted">Peak time {i + 1}</legend>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <input aria-label={`Peak ${i + 1} from`} className={`${input} min-w-[7rem] flex-1`} type="time" step={1800} value={p.start} onChange={(e) => setPeak(i, { start: e.target.value })} />
            <input aria-label={`Peak ${i + 1} until`} className={`${input} min-w-[7rem] flex-1`} type="time" step={1800} value={p.end} onChange={(e) => setPeak(i, { end: e.target.value })} />
            <input aria-label={`Peak ${i + 1} price per hour in dollars`} className={`${input} w-24`} inputMode="decimal" placeholder="$/h" required value={p.price} onChange={(e) => setPeak(i, { price: e.target.value })} />
          </div>
          <div className="flex gap-1">
            {DAY_SHORT.map((d, k) => (
              <button type="button" key={d} aria-label={`Peak ${i + 1} on ${DAY_NAMES[k]}`} aria-pressed={!!(p.days & (1 << k))} onClick={() => setPeak(i, { days: p.days ^ (1 << k) })}
                className={`min-h-11 flex-1 rounded-lg border py-1.5 text-xs sm:min-h-0 ${p.days & (1 << k) ? "border-ink bg-ink text-white" : "border-grid"}`}>{d}</button>
            ))}
          </div>
          <button type="button" onClick={() => setPeaks(peaks.filter((_, j) => j !== i))} className={`${textBtn} self-start text-sm`}>Remove this peak</button>
        </fieldset>
      ))}
      {peaks.length < 6 && <button type="button" onClick={() => setPeaks([...peaks, { start: "18:00", end: close === "24:00" ? "23:30" : close, price: "", days: 127 }])} className={`${textBtn} self-start text-sm text-action`}>Add a peak time</button>}
      {hasWholeClub && (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>Replace the current whole-club prices listed above. A court&apos;s own prices are kept.</span>
        </label>
      )}
      <button disabled={busy || (hasWholeClub && !replace)} className={primary}>Set prices</button>
    </form>
  );
}

function Staff({ clubId, staff, busy, run }: { clubId: string; staff: StaffRow[]; busy: boolean; run: Run }) {
  const [email, setEmail] = useState("");
  return (
    <section className={section}>
      <h2 className="font-medium">Staff (admin)</h2>
      <ul className="divide-y divide-grid">
        {staff.map((s) => (
          <li key={s.profile_id} className="flex items-center justify-between py-2 text-sm">
            <div>{s.name ?? "—"} <span className="text-muted">· {s.email}</span></div>
            <button disabled={busy} onClick={() => run(() => createClient().rpc("remove_club_staff", { p_club: clubId, p_profile: s.profile_id }))} className={`${textBtn} text-danger`}>Remove</button>
          </li>
        ))}
        {staff.length === 0 && <li className="py-2 text-sm text-muted">No staff yet. They must sign in once before you can add them.</li>}
      </ul>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().rpc("add_club_staff", { p_club: clubId, p_email: email.trim() }), () => setEmail("")); }}>
        <input className={`${input} flex-1`} type="email" placeholder="staff@email.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <button disabled={busy} className="rounded-xl border border-grid px-4">Add</button>
      </form>
    </section>
  );
}

function Coaches({ clubId, coaches, busy, run }: { clubId: string; coaches: CoachReq[]; busy: boolean; run: Run }) {
  const pending = coaches.filter((c) => c.status === "pending");
  const approved = coaches.filter((c) => c.status === "approved");
  const decide = (coachId: string, approve: boolean) => run(() => createClient().rpc("decide_coach_club", { p_coach: coachId, p_club: clubId, p_approve: approve }));
  return (
    <section className={section}>
      <h2 className="font-medium">Coaches</h2>
      {pending.length > 0 && (
        <ul className="divide-y divide-grid">
          {pending.map((c) => (
            <li key={c.coach_id} className="flex items-center justify-between py-2 text-sm">
              <div>{c.name ?? "Coach"} <span className="text-muted">· {c.sports.join(", ")} · ${Number(c.price_usd).toFixed(0)}/h</span><span className="ml-2 rounded-full bg-sand-soft px-2 py-0.5 text-xs">wants to be listed</span></div>
              <div className="flex gap-3"><button disabled={busy} onClick={() => decide(c.coach_id, true)} className={`${textBtn} text-action`}>Approve</button><button disabled={busy} onClick={() => decide(c.coach_id, false)} className={`${textBtn} text-muted`}>Decline</button></div>
            </li>
          ))}
        </ul>
      )}
      <ul className="divide-y divide-grid">
        {approved.length === 0 && pending.length === 0 && <li className="py-2 text-sm text-muted">No coaches yet. Coaches request a listing from their own profile.</li>}
        {approved.map((c) => (
          <li key={c.coach_id} className="flex items-center justify-between py-2 text-sm">
            <div>{c.name ?? "Coach"} <span className="text-muted">· {c.sports.join(", ")} · ${Number(c.price_usd).toFixed(0)}/h</span></div>
            <button disabled={busy} onClick={() => decide(c.coach_id, false)} className={`${textBtn} text-danger`}>Remove</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Onboarding audit (24 Nov): a pasted share link usually has no map point, and nothing used to say so. The link is
 *  still saved (players can open it); the exact point needs the long link, or the two numbers. */
export function MapLinkNote({ link, hasPoint }: { link: string; hasPoint: boolean }) {
  const kind = linkWithoutPoint(link);
  if (!kind || hasPoint) return null;
  return (
    <p role="status" className="rounded-lg bg-sand-soft px-3 py-2 text-xs">
      {kind === "short" ? "This is a short share link, which doesn't include the map point. " : "This link doesn't include the map point. "}
      Open it in Google Maps on a computer and copy the long address from the browser&apos;s address bar (it contains
      numbers like @34.2553,35.6586), then paste that here. Or long-press the entrance in Google Maps on a phone and
      copy the two numbers into Latitude and Longitude.
    </p>
  );
}
