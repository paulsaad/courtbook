import { redirect } from "next/navigation";
import { playerGatePath } from "@/lib/playerGate";
import { createClient } from "@/lib/supabase/server";
import { loadRefDataChecked as loadRefData } from "@/lib/refData";
import { todayIn } from "@/lib/time";
import CourtsDay, { type DaySlot } from "./CourtsDay";

/** Courts tab: one day, every club with its free start times. Public; reserving asks to sign in. */
export default async function CourtsPage({ searchParams }: { searchParams: Promise<{ date?: string; q?: string; at?: string; court?: string; dur?: string; club?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {   // signed in: the 18+ step; no name is asked to browse (Reserve asks for the name and contact phone)
    const q = new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === "string") as [string, string][]);
    const gate = await playerGatePath(supabase, user.id, `/courts${q.size ? `?${q}` : ""}`, "the courts", { requireName: false });
    if (gate) redirect(gate);
  }
  const today = todayIn("Asia/Beirut");
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const [ref, { data: slots, error }] = await Promise.all([
    loadRefData(supabase),
    supabase.rpc("club_day_slots", { p_date: date, p_query: sp.q?.trim() || null }),
  ]);
  const resume = sp.at && sp.court && !Number.isNaN(Date.parse(sp.at)) ? { at: sp.at, court: sp.court, dur: sp.dur ? Number(sp.dur) : null } : null;
  return <CourtsDay areas={ref.areas} sports={ref.sports} today={today} date={date} query={sp.q ?? ""} initial={(slots ?? []) as DaySlot[]} initialError={!!error} signedIn={!!user} resume={resume} />;
}
