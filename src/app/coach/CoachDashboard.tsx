"use client";

import { useRouter } from "next/navigation";
import type { Sport } from "@/lib/geo";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";
import { normalizePhone } from "@/lib/phone";

type Coach = { id: string; sports: string[]; levels: string[]; price_usd: number; bio: string | null; whatsapp: string | null; active: boolean } | null;
type ClubRow = { id: string; name: string; slug: string; timezone: string };
type LinkRow = { club_id: string; status: string };
type Rule = { id: string; club_id: string; weekday: number; start_time: string; end_time: string };
type Exc = { id: string; club_id: string; date: string; start_time: string | null; end_time: string | null; available: boolean };

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const input = "rounded-xl border border-grid bg-white px-3 py-2.5 text-base outline-none focus:border-action";
const primary = "rounded-xl bg-action px-4 py-2.5 font-medium text-white disabled:opacity-50";
const section = "flex flex-col gap-3 rounded-2xl border border-grid bg-white p-4";
const chip = (on: boolean) => `rounded-xl border px-3 py-2 text-sm ${on ? "border-ink bg-ink text-white" : "border-grid bg-white"}`;
const hhmm = (t: string) => t.slice(0, 5);

export default function CoachDashboard({ coach, sports, clubs, links, rules, exceptions }: { coach: Coach; sports: Sport[]; clubs: ClubRow[]; links: LinkRow[]; rules: Rule[]; exceptions: Exc[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true); setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return; }
    router.refresh();
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{coach ? "Coach profile" : "Become a coach"}</h1>
      {!coach && <p className="text-muted">Set your profile, ask the clubs where you coach to list you, and players will find you and message you on WhatsApp.</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
      <ProfileSection coach={coach} sports={sports} busy={busy} run={run} />
      {coach && <ClubsSection coach={coach} clubs={clubs} links={links} busy={busy} run={run} />}
      {coach && <AvailabilitySection coach={coach} clubs={clubs.filter((c) => links.some((l) => l.club_id === c.id && l.status === "approved"))} rules={rules} exceptions={exceptions} busy={busy} run={run} />}
    </>
  );
}

type Run = (fn: () => PromiseLike<{ error: { message: string } | null }>) => Promise<void>;

function ProfileSection({ coach, sports, busy, run }: { coach: Coach; sports: Sport[]; busy: boolean; run: Run }) {
  const [f, setF] = useState({ sports: coach?.sports ?? ["padel"], levels: coach?.levels ?? [], price: coach ? String(coach.price_usd) : "", bio: coach?.bio ?? "", whatsapp: coach?.whatsapp ?? "", active: coach?.active ?? true });
  const toggle = (k: "sports" | "levels", v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const [phoneError, setPhoneError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const phone = f.whatsapp.trim() ? normalizePhone(f.whatsapp) : null;
    if (f.whatsapp.trim() && !phone) { setPhoneError("Enter a Lebanese number like 03 123 456 or an international one like +961 3 123 456."); return; }
    setPhoneError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const row = { sports: f.sports, levels: f.levels, price_usd: Number(f.price), bio: f.bio.trim() || null, whatsapp: phone, active: f.active };
    run(() => coach ? supabase.from("coaches").update(row).eq("id", coach.id) : supabase.from("coaches").insert({ ...row, profile_id: user!.id }));
  }
  return (
    <form onSubmit={save} className={section}>
      <h2 className="font-medium">Profile</h2>
      {/* These rows wrap rather than scroll. This is a form where every option
          has to be found and tapped, so none of them may sit off-screen; the
          filter bars elsewhere scroll because only the active chip matters.
          Without wrapping, eight sports push the whole page sideways. */}
      <div className="text-sm">Sports<div className="mt-1 flex flex-wrap gap-2">{sports.map((s) => <button type="button" key={s.code} onClick={() => toggle("sports", s.code)} className={chip(f.sports.includes(s.code))}>{s.name_en}</button>)}</div></div>
      <div className="text-sm">Levels you coach<div className="mt-1 flex flex-wrap gap-2">{["beginner", "intermediate", "advanced"].map((s) => <button type="button" key={s} onClick={() => toggle("levels", s)} className={chip(f.levels.includes(s))}>{s}</button>)}</div></div>
      <label className="flex flex-col gap-1 text-sm">Price per hour ($)<input className={input} inputMode="decimal" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></label>
      <label className="flex flex-col gap-1 text-sm">WhatsApp number (players will message this)<input className={input} inputMode="tel" placeholder="03 123 456 or +961 3 123 456" value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} />
        {phoneError ? <span className="text-xs text-danger">{phoneError}</span> : f.whatsapp.trim() && normalizePhone(f.whatsapp) && <span className="text-xs text-muted">Saved as {normalizePhone(f.whatsapp)}</span>}</label>
      <label className="flex flex-col gap-1 text-sm">About you<textarea className={input} rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></label>
      {coach && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Listed (uncheck to pause)</label>}
      <button disabled={busy || f.sports.length === 0} className={primary}>{coach ? "Save" : "Create coach profile"}</button>
    </form>
  );
}

function ClubsSection({ coach, clubs, links, busy, run }: { coach: NonNullable<Coach>; clubs: ClubRow[]; links: LinkRow[]; busy: boolean; run: Run }) {
  const statusOf = (id: string) => links.find((l) => l.club_id === id)?.status;
  return (
    <section className={section}>
      <h2 className="font-medium">Clubs</h2>
      <p className="text-xs text-muted">Ask a club to list you. Its staff approve from their settings page.</p>
      <ul className="divide-y divide-grid">
        {clubs.map((c) => {
          const st = statusOf(c.id);
          return (
            <li key={c.id} className="flex items-center justify-between py-2 text-sm">
              <span>{c.name}</span>
              {st === "approved" ? <span className="rounded-full bg-turf-soft px-2 py-0.5 text-xs text-turf">listed</span>
                : st === "pending" ? <button disabled={busy} onClick={() => run(() => createClient().from("coach_clubs").delete().eq("coach_id", coach.id).eq("club_id", c.id))} className="text-xs text-muted underline">requested · withdraw</button>
                : st === "removed" || st === "declined" ? <button disabled={busy} onClick={() => run(async () => { const sb = createClient(); await sb.from("coach_clubs").delete().eq("coach_id", coach.id).eq("club_id", c.id); return sb.from("coach_clubs").insert({ coach_id: coach.id, club_id: c.id }); })} className="text-xs text-muted underline">{st} by club · request again</button>
                : <button disabled={busy} onClick={() => run(() => createClient().from("coach_clubs").insert({ coach_id: coach.id, club_id: c.id }))} className="text-action underline">Request listing</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AvailabilitySection({ coach, clubs, rules, exceptions, busy, run }: { coach: NonNullable<Coach>; clubs: ClubRow[]; rules: Rule[]; exceptions: Exc[]; busy: boolean; run: Run }) {
  const [clubId, setClubId] = useState(clubs[0]?.id ?? "");
  const [f, setF] = useState({ weekday: 0, start: "09:00", end: "12:00" });
  const [x, setX] = useState({ date: "", whole: true, start: "09:00", end: "12:00", available: false });
  if (clubs.length === 0) return <section className={section}><h2 className="font-medium">Availability</h2><p className="text-sm text-muted">Once a club lists you, set your weekly hours there.</p></section>;
  const mine = rules.filter((r) => r.club_id === clubId);
  return (
    <section className={section}>
      <h2 className="font-medium">Availability</h2>
      {clubs.length > 1 && <select className={input} value={clubId} onChange={(e) => setClubId(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      <ul className="divide-y divide-grid text-sm">
        {mine.length === 0 && <li className="py-2 text-muted">No weekly hours yet.</li>}
        {mine.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2"><span>{DAYS[r.weekday]} {hhmm(r.start_time)}–{hhmm(r.end_time)}</span>
            <button disabled={busy} onClick={() => run(() => createClient().from("availability_rules").delete().eq("id", r.id))} className="text-danger underline">Delete</button></li>
        ))}
      </ul>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("availability_rules").insert({ coach_id: coach.id, club_id: clubId, weekday: f.weekday, start_time: f.start, end_time: f.end })); }}>
        <select className={`${input} flex-1`} value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
        <input className={input} type="time" step={1800} value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
        <input className={input} type="time" step={1800} value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
        <button disabled={busy} className="rounded-xl border border-grid px-4 py-2.5 text-sm">Add weekly hours</button>
      </form>

      <h3 className="mt-2 text-sm font-medium">Exceptions at this club (days off, extra hours)</h3>
      <ul className="divide-y divide-grid text-sm">
        {exceptions.filter((e) => e.club_id === clubId).map((e) => (
          <li key={e.id} className="flex items-center justify-between py-2">
            <span>{e.date} · {e.available ? "extra" : "off"}{e.start_time ? ` ${hhmm(e.start_time)}–${hhmm(e.end_time!)}` : " all day"}</span>
            <button disabled={busy} onClick={() => run(() => createClient().from("availability_exceptions").delete().eq("id", e.id))} className="text-danger underline">Delete</button>
          </li>
        ))}
      </ul>
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createClient().from("availability_exceptions").insert({ coach_id: coach.id, club_id: clubId, date: x.date, available: x.available, start_time: x.whole ? null : x.start, end_time: x.whole ? null : x.end })); }}>
        <div className="flex gap-2">
          <input className={`${input} flex-1`} type="date" required value={x.date} onChange={(e) => setX({ ...x, date: e.target.value })} />
          <select className={input} value={x.available ? "extra" : "off"} onChange={(e) => setX({ ...x, available: e.target.value === "extra", whole: e.target.value === "extra" ? false : x.whole })}><option value="off">Day off</option><option value="extra">Extra hours</option></select>
        </div>
        {!x.available && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={x.whole} onChange={(e) => setX({ ...x, whole: e.target.checked })} /> Whole day</label>}
        {(!x.whole || x.available) && (
          <div className="flex gap-2"><input className={`${input} flex-1`} type="time" step={1800} value={x.start} onChange={(e) => setX({ ...x, start: e.target.value })} /><input className={`${input} flex-1`} type="time" step={1800} value={x.end} onChange={(e) => setX({ ...x, end: e.target.value })} /></div>
        )}
        <button disabled={busy} className="rounded-xl border border-grid px-4 py-2.5 text-sm">Add exception</button>
      </form>
    </section>
  );
}
