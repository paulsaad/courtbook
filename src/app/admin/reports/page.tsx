import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import ReportsBoard, { type Report, type ReportState } from "./ReportsBoard";
import { isMissingFunction } from "@/lib/missingFunction";
import WorkNav from "@/components/WorkNav";

// M3-S moderation: reports from players, their evidence, and the three decisions (handled, dismissed,
// suspend). Every read and write is an admin_* function that checks is_admin() itself; the role check
// here only decides what the page says.
const STATUSES = ["open", "actioned", "dismissed"] as const;

export default async function AdminReports({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: q } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/reports");
  const { data: me } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "the reports");
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const status = (STATUSES as readonly string[]).includes(q ?? "") ? (q as (typeof STATUSES)[number]) : "open";
  const { data, error } = await supabase.rpc("admin_reports", { p_status: status });
  // before migration 0074 the function does not exist: say so instead of failing
  const missing = !!error && (error.code === "PGRST202" || /admin_reports/.test(error.message ?? ""));
  const reports = (data ?? []) as Report[];
  // 0075: how many players blocked each reported player (moderator history); left out before 0075
  const ids = [...new Set(reports.map((r) => r.profile_id).filter((x): x is string => !!x))];
  const { data: blocks } = ids.length ? loaded(await supabase.rpc("admin_blocks_received", { p_profiles: ids }), "the reports") : { data: null };
  const blocksReceived = Object.fromEntries(((blocks ?? []) as { profile_id: string; blocks_received: number }[]).map((b) => [b.profile_id, b.blocks_received]));
  // 0082: legal hold, who handled it, history size; before 0082 the function is missing and those controls stay hidden
  const stateRes = reports.length ? await supabase.rpc("admin_report_state", { p_reports: reports.map((r) => r.id) }) : null;
  const state = !stateRes ? (missing ? null : {}) : stateRes.error && isMissingFunction(stateRes.error) ? null
    : Object.fromEntries(((loaded(stateRes, "the reports").data ?? []) as ReportState[]).map((x) => [x.report_id, x]));
  return <><WorkNav area="admin" active="reports" /><ReportsBoard status={status} reports={reports} blocksReceived={blocksReceived} unavailable={missing} failed={!!error && !missing} state={state} /></>;
}
