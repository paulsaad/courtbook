"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

/**
 * M2 (0086): every closed account not yet finished. Processing is automatic (inline on the website, then retries);
 * this page is the fallback (D4): Retry runs the same steps now, Release continues a held account once its hold is
 * lifted. There is no "force": the database still refuses staff, admins, legal holds and suspended accounts.
 */
export type Deletion = {
  subject_id: string; status: string; requested_at: string; requested_via: "app" | "web" | "support";
  name: string | null; phone: string | null; upcoming_bookings: number; upcoming_games_organised: number;
  open_reports_about: number; refusal: string | null;
};
export type Progress = {
  subject_id: string; status: string; held_reason: string | null; closing_at: string | null; banned_at: string | null;
  cancellations_at: string | null; data_removed_at: string | null; attempts: number; last_error: string | null;
  next_attempt_at: string | null; leased: boolean; alerted: boolean;
};
const STATUS: Record<string, string> = {
  closing: "Closed — sign-in not yet blocked",
  closed: "Closed — sign-in blocked; data not yet removed",
  data_removed: "Data removed — sign-in account still to delete",
  held: "Held — closed and blocked; waiting for review",
  requested: "Old request (before one-step closing)",
};
const HELD: Record<string, string> = {
  legal_hold: "A report about this player is on legal hold. Release once the hold is lifted.",
  coach_has_bookings: "Coach with coach bookings. Handle the bookings, then Release.",
  suspended: "Suspended account: waiting for the legal review (D3).",
};
const REFUSALS: Record<string, string> = {
  admin_role: "Has the admin role — remove it first.",
  staff_role: "Club staff — the club removes the staff role first.",
  legal_hold: "A report about this player is on legal hold.",
  coach_has_bookings: "Coach with coach bookings.",
};
const ERRORS: Record<string, string> = { ...REFUSALS, forbidden: "Admins only, and not for your own account.", not_held: "Not held any more. Reload the page.",
  suspended: "Still suspended: cannot be released until the legal review.", bad_request: "Reload the page and try again." };
const OUTCOMES: Record<string, string> = { done: "Finished.", held: "Held: cancellations done; waiting for review.",
  leased: "Another run is working on it right now. Try again in a few minutes.", busy: "Another run is working on it right now.",
  lease_lost: "Another run took over. Reload the page." };
/** The retry worker's last clean run (0086 admin_deletion_worker). The app offers one-step deletion only while
 *  `active` (a run in the last hour); the website processes inline either way. */
export type Worker = { last_run_at: string | null; active: boolean };
const when = (t: string | null) => (t ? formatInTimeZone(new Date(t), "Asia/Beirut", "d MMM HH:mm") : "—");

export function WorkerStatus({ worker }: { worker: Worker | null }) {
  if (!worker) return null;
  if (!worker.last_run_at) return <p role="status" className="card p-4 text-sm text-cedar">Automatic processing has never run here. Deleting an
    account from the app is paused (the app points people to the website); deletions on the website still run at once.</p>;
  if (worker.active) return <p role="status" className="text-sm text-muted">Automatic processing: last run {when(worker.last_run_at)}.</p>;
  return <p role="status" className="card p-4 text-sm text-cedar">Automatic processing last ran {when(worker.last_run_at)}, over an hour ago.
    Deleting an account from the app is paused until it runs again; deletions on the website still run at once.</p>;
}

export default function DeletionsBoard({ rows, progress, unavailable, failed, selfId, worker = null }:
  { rows: Deletion[]; progress: Progress[]; unavailable: boolean; failed: boolean; selfId: string; worker?: Worker | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const byId = new Map(progress.map((p) => [p.subject_id, p]));

  async function run(id: string, action: "retry" | "release") {
    setBusy(id);
    let text = "That did not work. Nothing was changed by this page; try again.";
    try {
      const res = await fetch("/api/admin/delete-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: id, action }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; outcome?: { result: string; reason?: string; step?: string; code?: string } };
      const o = body.outcome;
      if (body.error) text = ERRORS[body.error] ?? text;
      else if (o?.result === "failed") text = `Stopped at "${o.step}" (${o.code}). It is recorded and will be retried.`;
      else if (o) text = OUTCOMES[o.result === "skipped" ? o.reason ?? "" : o.result] ?? `Nothing to do (${o.reason ?? o.result}).`;
    } catch { /* network: the generic text */ }
    setBusy(null);
    setMsg((m) => ({ ...m, [id]: text }));
    router.refresh();
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-5 pt-10">
      <h1 className="text-2xl font-extrabold tracking-tight">Account deletions</h1>
      <p className="text-sm text-muted">Accounts are closed the moment the person confirms; the deletion then runs by itself. Listed here until it
        finishes. Retry runs the remaining steps now; Release continues a held account. Neither can be undone.</p>
      {!unavailable && <WorkerStatus worker={worker} />}
      {unavailable && <p className="card p-4 text-sm">One-step account closing is not set up in this database yet (migration 0086).</p>}
      {failed && <p role="alert" className="card p-4 text-sm text-cedar">The list could not be loaded. Reload the page.</p>}
      {!unavailable && !failed && rows.length === 0 && <p className="card p-4 text-sm">Nothing in progress.</p>}
      {rows.map((r) => {
        const p = byId.get(r.subject_id);
        const status = p?.status ?? r.status;
        const canRelease = status === "held" && !r.refusal && p?.held_reason !== "suspended";
        const canRetry = ["closing", "closed", "data_removed"].includes(status) || (status === "held" && !(p?.banned_at && p?.cancellations_at));
        const self = r.subject_id === selfId;
        return (
          <section key={r.subject_id} className="card flex flex-col gap-2 p-4 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <b className="text-[15px]">{r.name ?? "No name"}{r.phone ? ` · ${r.phone}` : ""}</b>
              <span className="text-muted">Closed {when(p?.closing_at ?? r.requested_at)} · {r.requested_via}</span>
            </div>
            <div className={status === "held" || p?.last_error ? "text-cedar" : ""}>{STATUS[status] ?? status}</div>
            {status === "held" && p?.held_reason && <div className="text-cedar">{HELD[p.held_reason] ?? p.held_reason}</div>}
            {status === "held" && r.refusal && <div className="text-cedar">{REFUSALS[r.refusal] ?? r.refusal}</div>}
            {p && (
              <div className="text-muted">
                Runs: {p.attempts}{p.last_error ? ` · last error: ${p.last_error}` : ""}
                {p.next_attempt_at && status !== "held" ? ` · next try ${when(p.next_attempt_at)}` : ""}
                {p.leased ? " · running now" : ""}{p.alerted ? " · alert sent" : ""}
              </div>
            )}
            <div>Upcoming bookings: {r.upcoming_bookings} · Games they organise: {r.upcoming_games_organised} · Open reports about them: {r.open_reports_about}</div>
            {!self && (canRetry || canRelease) && (
              <div className="flex gap-2">
                {canRetry && <button type="button" onClick={() => run(r.subject_id, "retry")} disabled={busy !== null} className="btn btn-secondary">{busy === r.subject_id ? "Working…" : "Retry now"}</button>}
                {canRelease && <button type="button" onClick={() => run(r.subject_id, "release")} disabled={busy !== null} className="btn btn-primary">{busy === r.subject_id ? "Working…" : "Release hold and continue"}</button>}
              </div>
            )}
            {msg[r.subject_id] && <p role="status" className="text-sm">{msg[r.subject_id]}</p>}
          </section>
        );
      })}
    </main>
  );
}
