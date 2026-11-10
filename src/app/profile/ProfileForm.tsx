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

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("profiles")
      .update({ name: f.name.trim(), phone: f.phone.trim() || null, level: f.level || null, sports: f.sports, email_notifications: f.email_notifications })
      .eq("id", user!.id);
    if (error) { setBusy(false); setError(error.message); return; }
    router.replace(next);
    router.refresh();
  }

  const toggleSport = (s: string) => setF({ ...f, sports: f.sports.includes(s) ? f.sports.filter((x) => x !== s) : [...f.sports, s] });
  const input = "rounded-xl border border-grid bg-white px-4 py-3 text-base outline-none focus:border-action";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{firstTime ? "Welcome. Who are you?" : "Your profile"}</h1>
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
        <button type="submit" disabled={busy} className="rounded-xl bg-action py-3.5 font-medium text-white disabled:opacity-50">{busy ? "Saving…" : firstTime ? "Continue" : "Save"}</button>
      </form>
      {!firstTime && (
        <section className="flex flex-col gap-1 rounded-2xl border border-grid bg-white p-4 text-sm">
          <h2 className="mb-1 font-medium">More</h2>
          <Link href="/notifications" className="py-2 text-action">Activity</Link>
          {manage.staffHref && <Link href={manage.staffHref} className="py-2 text-action">Staff calendar</Link>}
          {manage.isAdmin && <Link href="/admin" className="py-2 text-action">Admin: clubs &amp; payments</Link>}
          <Link href="/coach" className="py-2 text-action">{manage.isCoach ? "Coach profile" : "Are you a coach? Set up your coach profile"}</Link>
          <form action="/auth/signout" method="post" className="flex items-center justify-between border-t border-grid pt-3">
            <span className="text-muted">{manage.email}</span>
            <button className="text-danger">Sign out</button>
          </form>
        </section>
      )}
    </main>
  );
}
