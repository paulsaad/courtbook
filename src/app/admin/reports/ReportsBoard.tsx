"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/types";

export type Report = {
  id: string; created_at: string; target_kind: "message" | "player" | "game" | "feedback"; reason: string; note: string | null; snapshot: string | null;
  status: "open" | "actioned" | "dismissed"; reporter_id: string | null; reporter_name: string | null; profile_id: string | null; reported_name: string | null;
  reported_suspended: boolean; reports_against: number; match_id: string | null; message_id: string | null; message_deleted: boolean;
  handled_at: string | null; action: string | null;
};
/** 0082: what the board shows beyond admin_reports (absent before 0082). */
export type ReportState = { report_id: string; legal_hold: boolean; handled_by_name: string | null; closed_at: string | null; log_entries: number };
type LogRow = { at: string; admin_name: string | null; action: string; note: string | null };
const ACTIONS: Record<string, string> = { resolve: "Resolved", reopen: "Reopened", suspend: "Suspended", unsuspend: "Suspension lifted", hide_message: "Message hidden", legal_hold_on: "Legal hold on", legal_hold_off: "Legal hold off", clear_text: "Old text cleared", remove_photo: "Photo removed" };
type Line = { id: string; created_at: string; sender: string | null; body: string; deleted: boolean; reported: boolean };

const tz = "Asia/Beirut";
const when = (t: string) => formatInTimeZone(new Date(t), tz, "d MMM HH:mm");
const REASONS: Record<string, string> = { spam: "Spam", abuse: "Abuse or harassment", inappropriate: "Inappropriate", danger: "Threat or danger", other: "Something else", app_problem: "App problem", suggestion: "Suggestion" };
const KINDS: Record<string, string> = { message: "Message", player: "Player", game: "Game", feedback: "Help & Feedback" };
const TABS = [["open", "Open"], ["actioned", "Handled"], ["dismissed", "Dismissed"]] as const;

export default function ReportsBoard({ status, reports, unavailable, failed, blocksReceived = {}, state = null }: { status: string; reports: Report[]; unavailable: boolean; failed: boolean; blocksReceived?: Record<string, number>; state?: Record<string, ReportState> | null }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-5 p-5 pb-16">
      <Link href="/admin" className="text-sm text-muted">‹ Admin</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      {state && <ClearOldText />}
      <nav className="flex gap-2" aria-label="Report status">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/admin/reports?status=${k}`} aria-current={k === status ? "page" : undefined}
            className={`rounded-full border px-3 py-1.5 text-sm ${k === status ? "border-ink bg-ink text-white" : "border-grid bg-white"}`}>{label}</Link>
        ))}
      </nav>
      {unavailable && <p className="rounded-lg bg-slate-soft px-3 py-2 text-sm text-muted">Reports are not available on this database yet (migration 0074).</p>}
      {failed && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-danger">Could not load reports. Refresh to try again.</p>}
      {!unavailable && !failed && reports.length === 0 && <p className="text-sm text-muted">{status === "open" ? "No open reports." : "None."}</p>}
      {/* player reports first (they can need action), then app problems and suggestions (private feedback) */}
      {[["Player reports", reports.filter((r) => r.target_kind !== "feedback")], ["App problems and suggestions", reports.filter((r) => r.target_kind === "feedback")]].map(([title, list]) =>
        (list as Report[]).length > 0 && (
          <section key={title as string} className="flex flex-col gap-3" aria-label={title as string}>
            <h2 className="text-sm font-medium text-muted">{title as string} · {(list as Report[]).length}</h2>
            {(list as Report[]).map((r) => <ReportCard key={r.id} r={r} blocks={r.profile_id ? blocksReceived[r.profile_id] : undefined} st={state ? state[r.id] ?? null : null} />)}
          </section>
        ))}
    </main>
  );
}

/** 0082: the 180-day rule. It also runs by itself (every new report, every visit to this page); this runs it now. */
function ClearOldText() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button disabled={busy} onClick={async () => {
        setBusy(true); setMsg(null);
        const { data, error } = await createClient().rpc("clear_old_report_text", { p_days: 180 });
        setBusy(false);
        setMsg(error ? friendlyError(error.message) : `Cleared ${data ?? 0} report text(s) and log note(s) past the 180-day rule (legal holds and open cases kept). This also runs by itself on every visit and every new report.`);
      }} className="rounded-xl border border-grid bg-white px-3 py-2">Clear text of reports closed over 180 days ago</button>
      {msg && <span role="status" className="text-muted">{msg}</span>}
    </div>
  );
}

/** A moderation action that needs a reason; the reason goes into the moderation log. */
function WithReason({ label, prompt, danger, busy, onSubmit }: { label: string; prompt: string; danger?: boolean; busy: boolean; onSubmit: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <button disabled={busy} onClick={() => setOpen(true)} className={`rounded-xl border border-grid bg-white px-3 py-2 ${danger ? "text-danger" : ""}`}>{label}</button>;
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-grid p-3">
      <label className="text-muted">{prompt}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 w-full rounded-xl border border-grid px-3 py-2 text-base text-ink outline-none focus:border-action" /></label>
      <div className="flex gap-2">
        <button disabled={busy || !reason.trim()} onClick={() => onSubmit(reason.trim())} className="rounded-xl bg-action px-3 py-2 font-medium text-white disabled:opacity-50">{label}</button>
        <button disabled={busy} onClick={() => setOpen(false)} className="rounded-xl border border-grid bg-white px-3 py-2">Cancel</button>
      </div>
    </div>
  );
}

function ReportCard({ r, blocks, st }: { r: Report; blocks?: number; st: ReportState | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [action, setAction] = useState("");
  const [suspending, setSuspending] = useState(false);
  const [history, setHistory] = useState<LogRow[] | null>(null);
  const [reason, setReason] = useState("");

  async function call(fn: string, args: Record<string, unknown>) {
    setBusy(true); setError(null);
    const { data, error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) { setError(friendlyError(error.message)); return null; }
    return { data };
  }
  const refresh = async (fn: string, args: Record<string, unknown>) => { if (await call(fn, args)) router.refresh(); };
  async function showConversation() {
    const out = await call("admin_report_messages", { p_report: r.id });
    if (out) setLines((out.data ?? []) as Line[]);
  }
  async function showHistory() {
    const out = await call("admin_moderation_log", { p_report: null, p_profile: r.profile_id ?? null });
    if (out) setHistory(((out.data ?? []) as (LogRow & { report_id: string | null })[]).filter((l) => r.profile_id || l.report_id === r.id));
  }
  const open = r.status === "open";
  const who = r.reported_name ?? "this player";

  return (
    <article className="rounded-2xl border border-grid bg-white p-4 text-sm" aria-label={`Report ${KINDS[r.target_kind]} ${REASONS[r.reason] ?? r.reason}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium">{KINDS[r.target_kind]} · {REASONS[r.reason] ?? r.reason}</h2>
        <span className="text-xs text-muted">{st?.legal_hold && <span className="mr-2 rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800">legal hold</span>}{when(r.created_at)}</span>
      </div>
      <p className="mt-1 text-muted">
        Reported by {r.reporter_name ?? "a player"}
        {r.profile_id && <> · about <span className="text-ink">{r.reported_name ?? "a player"}</span>{r.reported_suspended && <span className="ml-1 rounded bg-red-50 px-1.5 py-0.5 text-xs text-danger">suspended</span>}{r.reports_against > 1 && <> · {r.reports_against} reports in total</>}{!!blocks && <> · blocked by {blocks} player{blocks > 1 ? "s" : ""}</>}</>}
      </p>
      {r.target_kind === "feedback" ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words">{r.note}</p>
          {r.snapshot && <p className="mt-1 text-xs text-muted">Sent from {r.snapshot}</p>}
        </>
      ) : r.note && <p className="mt-2"><span className="text-muted">Their note: </span>{r.note}</p>}
      {r.snapshot != null && r.target_kind !== "feedback" && (
        <blockquote className="mt-2 rounded-lg border-l-4 border-grid bg-paper px-3 py-2">
          <div className="text-xs text-muted">{r.target_kind === "message" ? "The message, as reported" : "As reported"}{r.message_deleted && " · since deleted"}</div>
          <div className="whitespace-pre-wrap break-words">{r.snapshot}</div>
        </blockquote>
      )}
      {r.match_id && !lines && <button disabled={busy} onClick={showConversation} className="mt-2 text-action underline">Show conversation</button>}
      {lines && (
        <ol className="mt-2 flex flex-col gap-1 rounded-lg bg-paper p-2" aria-label="Conversation around the report">
          {lines.length === 0 && <li className="text-muted">No messages.</li>}
          {[...lines].reverse().map((l) => (
            <li key={l.id} className={l.reported ? "rounded bg-red-50 px-1" : ""}>
              <span className="text-xs text-muted">{when(l.created_at)} {l.sender ?? "Player"}: </span>
              {l.deleted ? <em className="text-muted">deleted</em> : l.body}
            </li>
          ))}
        </ol>
      )}
      {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-danger">{error}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {r.message_id && !r.message_deleted && open && (
          <button disabled={busy} onClick={() => refresh("admin_hide_message", { p_message: r.message_id })} className="rounded-xl border border-grid bg-white px-3 py-2">Hide message</button>
        )}
        {r.profile_id && !r.reported_suspended && !suspending && (
          <button disabled={busy} onClick={() => setSuspending(true)} className="rounded-xl border border-grid bg-white px-3 py-2 text-danger">Suspend account</button>
        )}
        {r.profile_id && r.reported_suspended && (st
          ? <WithReason label="Lift suspension" prompt={`Why lift the suspension of ${who}? (kept in the moderation log)`} busy={busy} onSubmit={(why) => refresh("admin_unsuspend", { p_profile: r.profile_id, p_reason: why })} />
          : <button disabled={busy} onClick={() => refresh("admin_unsuspend", { p_profile: r.profile_id })} className="rounded-xl border border-grid bg-white px-3 py-2">Lift suspension</button>
        )}
        {/* player photo (draft #67, review requirement 2): remove an inappropriate photo without suspending the account */}
        {r.profile_id && <WithReason label="Remove photo" danger prompt={`Why remove ${who}'s photo? (kept in the moderation log; they can upload a new one)`} busy={busy}
          onSubmit={(why) => refresh("admin_remove_player_photo", { p_profile: r.profile_id, p_reason: why })} />}
        {st && <WithReason label={st.legal_hold ? "Release legal hold" : "Put on legal hold"} prompt={st.legal_hold ? "Why release the hold? (its text can then be cleared on schedule)" : "Why hold this report? (its text will not be cleared)"} busy={busy}
          onSubmit={(why) => refresh("admin_set_legal_hold", { p_report: r.id, p_hold: !st.legal_hold, p_note: why })} />}
        {st && st.log_entries > 0 && !history && <button disabled={busy} onClick={showHistory} className="rounded-xl border border-grid bg-white px-3 py-2">History ({st.log_entries})</button>}
      </div>
      {history && (
        <ol className="mt-2 flex flex-col gap-1 rounded-lg bg-paper p-2" aria-label="Moderation history">
          {history.length === 0 && <li className="text-muted">Nothing recorded.</li>}
          {history.map((h, i) => <li key={i}><span className="text-xs text-muted">{when(h.at)} {h.admin_name ?? "Admin"}: </span>{ACTIONS[h.action] ?? h.action}{h.note && <span className="text-muted"> — {h.note}</span>}</li>)}
        </ol>
      )}
      {suspending && (
        <div className="mt-2 flex flex-col gap-2 rounded-xl border border-grid p-3">
          <label className="text-muted" htmlFor={`reason-${r.id}`}>Why suspend {who}? (kept with the suspension)</label>
          <input id={`reason-${r.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="rounded-xl border border-grid px-3 py-2 text-base outline-none focus:border-action" />
          <p className="text-xs text-muted">They will not be able to post, join, manage games or send messages until the suspension is lifted.</p>
          <div className="flex gap-2">
            <button disabled={busy || !reason.trim()} onClick={() => refresh("admin_suspend", { p_profile: r.profile_id, p_reason: reason.trim() })} className="rounded-xl bg-danger px-3 py-2 font-medium text-white disabled:opacity-50">Suspend {who}</button>
            <button disabled={busy} onClick={() => setSuspending(false)} className="rounded-xl border border-grid bg-white px-3 py-2">Cancel</button>
          </div>
        </div>
      )}
      {open ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-grid pt-3">
          <input aria-label="What was done (optional)" placeholder="What was done (optional)" value={action} onChange={(e) => setAction(e.target.value)} maxLength={300}
            className="rounded-xl border border-grid px-3 py-2 text-base outline-none focus:border-action" />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => refresh("admin_resolve_report", { p_report: r.id, p_status: "actioned", p_action: action })} className="rounded-xl bg-action px-3 py-2 font-medium text-white disabled:opacity-50">Mark handled</button>
            <button disabled={busy} onClick={() => refresh("admin_resolve_report", { p_report: r.id, p_status: "dismissed", p_action: action })} className="rounded-xl border border-grid bg-white px-3 py-2">Dismiss</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2 border-t border-grid pt-3">
          <p className="text-muted">{r.status === "actioned" ? "Handled" : "Dismissed"}{r.handled_at && ` ${when(r.handled_at)}`}{st?.handled_by_name && ` by ${st.handled_by_name}`}{r.action && ` · ${r.action}`}</p>
          {st && <WithReason label="Reopen" prompt="Why reopen it? (the earlier decision stays in the log)" busy={busy} onSubmit={(why) => refresh("admin_reopen_report", { p_report: r.id, p_note: why })} />}
        </div>
      )}
    </article>
  );
}
