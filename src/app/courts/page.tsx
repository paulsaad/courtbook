import { createClient } from "@/lib/supabase/server";
import { loadRefData } from "@/lib/geo";
import { todayIn } from "@/lib/time";
import CourtsDay, { type DaySlot } from "./CourtsDay";

/** Courts tab: one day, every club with its free start times. Public; reserving asks to sign in. */
export default async function CourtsPage({ searchParams }: { searchParams: Promise<{ date?: string; q?: string; at?: string; court?: string; dur?: string; club?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const today = todayIn("Asia/Beirut");
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const [ref, { data: slots, error }] = await Promise.all([
    loadRefData(supabase),
    supabase.rpc("club_day_slots", { p_date: date, p_query: sp.q?.trim() || null }),
  ]);
  const resume = sp.at && sp.court && !Number.isNaN(Date.parse(sp.at)) ? { at: sp.at, court: sp.court, dur: sp.dur ? Number(sp.dur) : null } : null;
  return <CourtsDay areas={ref.areas} sports={ref.sports} today={today} date={date} query={sp.q ?? ""} initial={(slots ?? []) as DaySlot[]} initialError={!!error} signedIn={!!user} resume={resume} />;
}
