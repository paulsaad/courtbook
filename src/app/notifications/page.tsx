import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import ActivityList, { type Note } from "./ActivityList";

export default async function NotificationsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/notifications");
  const { data } = loaded(await supabase.from("notifications").select("id, kind, match_id, body, created_at, read_at").eq("profile_id", user.id).order("created_at", { ascending: false }).limit(50), "your activity");
  const rows = (data ?? []) as Note[];
  if (rows.some((r) => !r.read_at)) await supabase.rpc("mark_notifications_read", { p_ids: rows.filter((r) => !r.read_at).map((r) => r.id) });
  return (
    <main className="mx-auto flex min-h-screen max-w-md md:max-w-2xl lg:max-w-[720px] flex-col gap-4 p-5 pt-12">
      <Link href="/profile" className="text-sm text-muted">‹ Profile</Link>
      <ActivityList initial={rows} />
    </main>
  );
}
