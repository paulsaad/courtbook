"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

type ClubRow = {
  id: string; name: string; slug: string; active: boolean; timezone: string; location_url: string | null;
  open_time: string; close_time: string; slot_minutes: number; min_booking_minutes: number; max_booking_minutes: number;
  cancel_cutoff_hours: number; hold_minutes: number; booking_window_days: number; service_fee_usd: number;
};
type CourtRow = { id: string; name: string; sport: string; surface: string | null; active: boolean; sort: number };
type RuleRow = { id: string; court_id: string | null; weekday_mask: number; start_time: string; end_time: string; price_usd: number; label: string | null };
type StaffRow = { profile_id: string; name: string | null; email: string };

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const input = "rounded-xl border border-grid bg-white px-3 py-2.5 text-base outline-none focus:border-action";
const primary = "rounded-xl bg-action px-4 py-2.5 font-medium text-white disabled:opacity-50";
const hhmm = (t: string) => t.slice(0, 5);
const section = "flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4";

export default function ClubSettings({ club, courts, rules, staff, isAdmin, backHref }: { club: ClubRow; courts: CourtRow[]; rules: RuleRow[]; staff: StaffRow[]; isAdmin: boolean; backHref: string }) {
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

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-16">
      <Link href={backHref} className="text-sm text-muted">‹ Back</Link>
      <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}

      {isAdmin && <AdminBasics club={club} busy={busy} run={run} />}
      <Hours club={club} busy={busy} run={run} />
      <Courts clubId={club.id} courts={courts} busy={busy} run={run} />
      <Prices clubId={club.id} courts={courts} rules={rules} busy={busy} run={run} />
      {isAdmin && <Staff clubId={club.id} staff={staff} busy={busy} run={run} />}
    </main>
  );
}

type Run = (fn: () => PromiseLike<{ error: { message: string } | null }>, after?: () => void) => Promise<boolean>;

function AdminBasics({ club, busy, run }: { club: ClubRow; busy: boolean; run: Run }) {
  const [name, setName] = useState(club.name);
  const [fee, setFee] = useState(String(club.service_fee_usd));
  const [active, setActive] = useState(club.active);
  return (
    <section className={section}>
      <h2 className="font-medium">Club (admin)</h2>
      <label className="flex flex-col gap-1 text-sm">Name<input className={input} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="flex flex-col gap-1 text-sm">CourtBook fee per booking ($)<input className={input} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Visible to players</label>
      <button disabled={busy} onClick={() => run(() => createClient().from("clubs").update({ name: name.trim(), service_fee_usd: Number(fee), active }).eq("id", club.id))} className={primary}>Save</button>
    </section>
  );
}

function Hours({ club, busy, run }: { club: ClubRow; busy: boolean; run: Run }) {
  const [f, setF] = useState({
    open: hhmm(club.open_time), close: club.close_time.startsWith("24") ? "24:00" : hhmm(club.close_time),
    slot: club.slot_minutes, min: club.min_booking_minutes, max: club.max_booking_minutes,
    cutoff: club.cancel_cutoff_hours, hold: club.hold_minutes, window: club.booking_window_days, location: club.location_url ?? "",
  });
  const set = (k: keyof typeof f, v: string | number) => setF({ ...f, [k]: v });
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
      <label className="flex flex-col gap-1 text-sm">Map link<input className={input} placeholder="https://maps.google.com/…" value={f.location} onChange={(e) => set("location", e.target.value)} /></label>
      <p className="text-xs text-muted">Min/max must be multiples of the grid step. 23:59 means midnight.</p>
      <button disabled={busy} onClick={() => run(() => createClient().rpc("update_club_settings", {
        p_club: club.id, p_open: f.open, p_close: f.close === "24:00" ? "24:00:00" : f.close, p_slot: f.slot, p_min: f.min, p_max: f.max,
        p_cutoff: f.cutoff, p_hold: f.hold, p_window: f.window, p_location: f.location,
      }))} className={primary}>Save</button>
    </section>
  );
}

function Courts({ clubId, courts, busy, run }: { clubId: string; courts: CourtRow[]; busy: boolean; run: Run }) {
  const [name, setName] = useState("");
  const [sport, setSport] = useState("padel");
  const [surface, setSurface] = useState("");
  return (
    <section className={section}>
      <h2 className="font-medium">Courts</h2>
      <ul className="divide-y divide-grid">
        {courts.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2 text-sm">
            <div><span className={c.active ? "" : "text-muted line-through"}>{c.name}</span> <span className="text-muted">· {c.sport}{c.surface ? ` · ${c.surface}` : ""}</span></div>
            <button disabled={busy} onClick={() => run(() => createClient().from("courts").update({ active: !c.active }).eq("id", c.id))} className="text-action underline">{c.active ? "Deactivate" : "Activate"}</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("courts").insert({ club_id: clubId, name: name.trim(), sport, surface: surface.trim() || null, sort: courts.length + 1 }), () => { setName(""); setSurface(""); }); }}>
        <div className="flex gap-2">
          <input className={`${input} flex-1`} placeholder="Court name" required value={name} onChange={(e) => setName(e.target.value)} />
          <select className={input} value={sport} onChange={(e) => setSport(e.target.value)}><option value="padel">padel</option><option value="tennis">tennis</option><option value="other">other</option></select>
        </div>
        <input className={input} placeholder="Surface (optional)" value={surface} onChange={(e) => setSurface(e.target.value)} />
        <button disabled={busy} className="rounded-xl border border-grid py-2.5">Add court</button>
      </form>
    </section>
  );
}

function Prices({ clubId, courts, rules, busy, run }: { clubId: string; courts: CourtRow[]; rules: RuleRow[]; busy: boolean; run: Run }) {
  const [f, setF] = useState({ label: "", start: "08:00", end: "17:00", price: "", court: "", mask: 127 });
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
            <button disabled={busy} onClick={() => run(() => createClient().from("price_rules").delete().eq("id", r.id))} className="text-danger underline">Delete</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("price_rules").insert({ club_id: clubId, court_id: f.court || null, weekday_mask: f.mask, start_time: f.start, end_time: f.end, price_usd: Number(f.price), label: f.label.trim() || null }), () => setF({ ...f, price: "", label: "" })); }}>
        <div className="flex gap-2">
          <input className={`${input} flex-1`} type="time" step={1800} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
          <input className={`${input} flex-1`} type="time" step={1800} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
          <input className={`${input} w-24`} inputMode="decimal" placeholder="$/h" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
        </div>
        <div className="flex gap-1">
          {DAYS.map((d, i) => <button type="button" key={d} onClick={() => toggleDay(i)} className={`flex-1 rounded-lg border py-1.5 text-xs ${f.mask & (1 << i) ? "border-ink bg-ink text-white" : "border-grid"}`}>{d}</button>)}
        </div>
        <div className="flex gap-2">
          <select className={`${input} flex-1`} value={f.court} onChange={(e) => setF({ ...f, court: e.target.value })}><option value="">All courts</option>{courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input className={`${input} flex-1`} placeholder="Label (peak…)" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
        </div>
        <button disabled={busy} className="rounded-xl border border-grid py-2.5">Add price rule</button>
      </form>
    </section>
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
            <button disabled={busy} onClick={() => run(() => createClient().rpc("remove_club_staff", { p_club: clubId, p_profile: s.profile_id }))} className="text-danger underline">Remove</button>
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
