import Link from "next/link";
import { redirect } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { createClient } from "@/lib/supabase/server";

export default async function NotificationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/notifications");
  const { data } = await supabase.from("notifications").select("id, kind, match_id, body, created_at, read_at").eq("profile_id", user.id).order("created_at", { ascending: false }).limit(50);
  const rows = data ?? [];
  if (rows.some((r) => !r.read_at)) await supabase.rpc("mark_notifications_read", { p_ids: rows.filter((r) => !r.read_at).map((r) => r.id) });
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5">
      <Link href="/" className="text-sm text-muted">‹ Home</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <ul className="divide-y divide-grid rounded-2xl border border-grid bg-white">
        {rows.length === 0 && <li className="p-6 text-center text-sm text-muted">Nothing yet.</li>}
        {rows.map((n) => (
          <li key={n.id}>
            <Link href={n.match_id ? `/matches/${n.match_id}` : "/"} className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? "" : "bg-turf-soft/40"}`}>
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-turf" style={{ opacity: n.read_at ? 0 : 1 }} />
              <div className="min-w-0 flex-1"><div className="text-sm">{n.body}</div><div className="text-xs text-muted">{formatInTimeZone(new Date(n.created_at), "Asia/Beirut", "EEE d MMM HH:mm")}</div></div>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
