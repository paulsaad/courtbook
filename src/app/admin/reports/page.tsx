import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReportsBoard, { type Report } from "./ReportsBoard";

// M3-S moderation: reports from players, their evidence, and the three decisions (handled, dismissed,
// suspend). Every read and write is an admin_* function that checks is_admin() itself; the role check
// here only decides what the page says.
const STATUSES = ["open", "actioned", "dismissed"] as const;

export default async function AdminReports({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: q } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/reports");
  const { data: me } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  if (!me?.roles?.includes("admin")) return <main className="p-6">Admins only.</main>;

  const status = (STATUSES as readonly string[]).includes(q ?? "") ? (q as (typeof STATUSES)[number]) : "open";
  const { data, error } = await supabase.rpc("admin_reports", { p_status: status });
  // before migration 0074 the function does not exist: say so instead of failing
  const missing = !!error && (error.code === "PGRST202" || /admin_reports/.test(error.message ?? ""));
  const reports = (data ?? []) as Report[];
  // 0075: how many players blocked each reported player (moderator history); left out before 0075
  const ids = [...new Set(reports.map((r) => r.profile_id).filter((x): x is string => !!x))];
  const { data: blocks } = ids.length ? await supabase.rpc("admin_blocks_received", { p_profiles: ids }) : { data: null };
  const blocksReceived = Object.fromEntries(((blocks ?? []) as { profile_id: string; blocks_received: number }[]).map((b) => [b.profile_id, b.blocks_received]));
  return <ReportsBoard status={status} reports={reports} blocksReceived={blocksReceived} unavailable={missing} failed={!!error && !missing} />;
}
