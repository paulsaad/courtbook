"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

export type Deletion = {
  subject_id: string; status: "requested" | "data_removed"; requested_at: string; requested_via: "app" | "web" | "support";
  name: string | null; phone: string | null; upcoming_bookings: number; upcoming_games_organised: number;
  open_reports_about: number; refusal: string | null;
};
const REFUSALS: Record<string, string> = {
  admin_role: "Has the admin role — remove it first.",
  staff_role: "Club staff — the club removes the staff role first.",
  legal_hold: "A report about this player is on legal hold — keep until the hold is lifted.",
  coach_has_bookings: "Coach with coach bookings — handle by hand.",
};
const ERRORS: Record<string, string> = { ...REFUSALS, forbidden: "Admins only.", no_open_request: "No open request (already done or cancelled).",
  auth_step_failed: "Their data is removed, but the sign-in account could not be deleted. Press Delete again.",
  account_still_exists: "The sign-in account still exists. Press Delete again." };
const when = (t: string) => formatInTimeZone(new Date(t), "Asia/Beirut", "d MMM yyyy");
const days = (t: string) => Math.floor((Date.now() - new Date(t).getTime()) / 86_400_000);

export default function DeletionsBoard({ rows, unavailable, failed }: { rows: Deletion[]; unavailable: boolean; failed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});

  async function run(id: string) {
    setBusy(id); setConfirm(null);
    const res = await fetch("/api/admin/delete-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: id }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(null);
    if (res.ok) { router.refresh(); return; }
    setMsg((m) => ({ ...m, [id]: ERRORS[body.error ?? ""] ?? "That did not work. Nothing was finished; try again." }));
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-5 pt-10">
      <h1 className="text-2xl font-extrabold tracking-tight">Account deletion requests</h1>
      <p className="text-sm text-muted">Delete cancels their upcoming bookings (normal rules) and the games they organise, removes their
        name, phone, messages and sign-in, and keeps bookings and payments without their name. It cannot be undone.</p>
      {unavailable && <p className="card p-4 text-sm">Account deletion is not set up in this database yet (migration 0079).</p>}
      {failed && <p role="alert" className="card p-4 text-sm text-cedar">The requests could not be loaded. Reload the page.</p>}
      {!unavailable && !failed && rows.length === 0 && <p className="card p-4 text-sm">No open requests.</p>}
      {rows.map((r) => (
        <section key={r.subject_id} className="card flex flex-col gap-2 p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <b className="text-[15px]">{r.name ?? "No name"}{r.phone ? ` · ${r.phone}` : ""}</b>
            <span className="text-muted">Asked {when(r.requested_at)} ({days(r.requested_at)} days ago) · {r.requested_via}</span>
          </div>
          <div>Upcoming bookings: {r.upcoming_bookings} · Games they organise: {r.upcoming_games_organised} · Open reports about them: {r.open_reports_about}</div>
          {r.status === "data_removed" && <div className="text-cedar">Data removed; the sign-in account is still to be deleted. Press Delete to finish.</div>}
          {r.refusal ? <div className="text-cedar">{REFUSALS[r.refusal] ?? r.refusal}</div>
            : confirm === r.subject_id ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => run(r.subject_id)} disabled={busy !== null} className="btn btn-primary">Delete permanently</button>
                <button type="button" onClick={() => setConfirm(null)} className="btn btn-secondary">Cancel</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirm(r.subject_id)} disabled={busy !== null} className="self-start py-1 font-semibold text-cedar">
                {busy === r.subject_id ? "Deleting…" : "Delete…"}
              </button>
            )}
          {msg[r.subject_id] && <p role="alert" className="text-cedar">{msg[r.subject_id]}</p>}
        </section>
      ))}
    </main>
  );
}
