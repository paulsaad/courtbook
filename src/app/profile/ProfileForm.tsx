"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Initial = { name: string; phone: string; level: string; sports: string[]; email_notifications: boolean };
const LEVELS = [["beginner", "Beginner"], ["intermediate", "Intermediate"], ["advanced", "Advanced"]] as const;

type Manage = { staffHref: string | null; isAdmin: boolean; isCoach: boolean; email: string };

export default function ProfileForm({ initial, next, firstTime, sports, manage }: { initial: Initial; next: string; firstTime: boolean; sports: { code: string; name_en: string }[]; manage: Manage }) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(firstTime);
  const levelName = (v: string) => LEVELS.find(([k]) => k === v)?.[1] ?? "level not set";
  const sportName = (code: string) => sports.find((s) => s.code === code)?.name_en ?? code;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("profiles")
      .update({ name: f.name.trim(), phone: f.phone.trim() || null, level: f.level || null, sports: f.sports, email_notifications: f.email_notifications })
      .eq("id", user!.id);
    if (error) { setBusy(false); setError(error.message); return; }
    setBusy(false);
    if (firstTime) { router.replace(next); router.refresh(); return; }
    setEditing(false); router.refresh();
  }

  const toggleSport = (s: string) => setF({ ...f, sports: f.sports.includes(s) ? f.sports.filter((x) => x !== s) : [...f.sports, s] });
  const input = "rounded-xl border border-grid bg-white px-4 py-3 text-base outline-none focus:border-action";

  const row = (label: React.ReactNode, href: string) => (
    <Link href={href} className="flex items-center justify-between border-t border-grid px-4 py-4 text-base">{label}<span className="text-[#8a918e]">›</span></Link>
  );
  const initials = (initial.name || manage.email || "?").split(/[\s@]+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  if (!editing) return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pt-12">
      <div className="flex flex-col items-center gap-2">
        <span className="flex h-28 w-28 items-center justify-center rounded-full border-4 border-white bg-turf text-[40px] font-extrabold text-white shadow-[0_0_0_1px_#e6e8e5]" aria-hidden="true">{initials}</span>
        <div className="text-2xl font-extrabold tracking-tight">{initial.name}</div>
        <div className="text-sm text-muted">{manage.email}{initial.phone ? ` · ${initial.phone}` : ""}</div>
        <button onClick={() => setEditing(true)} className="chip mt-1">Edit name, phone, level</button>
      </div>
      <section className="flex flex-col gap-2.5">
        <h2 className="text-xl font-bold">Your sports</h2>
        <div className="flex flex-wrap gap-2">
          {initial.sports.map((sp) => <button key={sp} onClick={() => setEditing(true)} className="chip gap-2">{sportName(sp)} <span className="text-[#8a918e]">·</span> <b className="text-turf">{levelName(initial.level)}</b></button>)}
          <button onClick={() => setEditing(true)} className="chip border-dashed border-cedar font-semibold text-cedar">+ Add a sport</button>
        </div>
      </section>
      <section className="card overflow-hidden">
        <div className="eyebrow px-4 pb-1.5 pt-3.5">Account</div>
        {row("Activity", "/notifications")}
        {row("Your bookings and matches", "/me")}
      </section>
      {(manage.staffHref || manage.isAdmin || manage.isCoach) && (
        <section className="card overflow-hidden">
          <div className="eyebrow px-4 pb-1.5 pt-3.5">You manage</div>
          {manage.staffHref && row("Staff calendar", manage.staffHref)}
          {manage.isAdmin && row("Admin: clubs & payments", "/admin")}
          {manage.isCoach && row("Coach profile", "/coach")}
        </section>
      )}
      {!manage.isCoach && <Link href="/coach" className="text-center text-sm text-muted">Are you a coach? <span className="font-semibold text-turf">Set up your coach profile</span></Link>}
      <form action="/auth/signout" method="post" className="text-center"><button className="py-2 text-[15px] font-semibold text-cedar">Sign out</button></form>
    </main>
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pt-12">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">{firstTime ? "Welcome. Who are you?" : "Edit profile"}</h1>
        <p className="mt-1 text-sm text-muted">Clubs see your name on bookings. Your phone is only shown to club staff.</p>
      </div>
      <form onSubmit={save} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">Name
          <input className={input} required autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Phone (WhatsApp)
          <input className={input} inputMode="tel" autoComplete="tel" placeholder="03 123 456" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </label>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Level</legend>
          <div className="flex gap-2">
            {LEVELS.map(([v, l]) => (
              <button type="button" key={v} onClick={() => setF({ ...f, level: v })} className={`flex-1 rounded-xl border py-2 ${f.level === v ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{l}</button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Sports</legend>
          <div className="flex flex-wrap gap-2">
            {sports.map((sp) => (
              <button type="button" key={sp.code} onClick={() => toggleSport(sp.code)} className={`rounded-xl border px-4 py-2 ${f.sports.includes(sp.code) ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{sp.name_en}</button>
            ))}
          </div>
        </fieldset>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy} className="btn btn-primary">{busy ? "Saving…" : firstTime ? "Continue" : "Save"}</button>
        {!firstTime && <button type="button" onClick={() => setEditing(false)} className="btn btn-secondary">Cancel</button>}
      </form>
    </main>
  );
}
