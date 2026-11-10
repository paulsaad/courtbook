import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CoachDashboard from "./CoachDashboard";

export default async function CoachPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/coach");

  const { data: coach } = await supabase.from("coaches").select("id, sports, levels, price_usd, bio, whatsapp, active").eq("profile_id", user.id).maybeSingle();
  const { data: clubs } = await supabase.from("clubs").select("id, name, slug, timezone").eq("active", true).order("name");
  const [{ data: links }, { data: rules }, { data: exceptions }] = coach
    ? await Promise.all([
        supabase.from("coach_clubs").select("club_id, status").eq("coach_id", coach.id),
        supabase.from("availability_rules").select("id, club_id, weekday, start_time, end_time").eq("coach_id", coach.id).order("weekday").order("start_time"),
        supabase.from("availability_exceptions").select("id, club_id, date, start_time, end_time, available").eq("coach_id", coach.id).gte("date", new Date().toISOString().slice(0, 10)).order("date"),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-5 p-5 pb-16">
      <Link href="/" className="text-sm text-muted">‹ Home</Link>
      <CoachDashboard coach={coach} clubs={clubs ?? []} links={links ?? []} rules={rules ?? []} exceptions={exceptions ?? []} />
    </main>
  );
}
