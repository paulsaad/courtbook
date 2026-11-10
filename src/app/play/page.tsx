import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadRefData } from "@/lib/geo";
import PlayBoard from "./PlayBoard";
import type { OpenMatch } from "@/components/Discover";

export default async function PlayPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/play");
  const [ref, { data: matches }, { data: clubs }] = await Promise.all([
    loadRefData(supabase),
    supabase.rpc("open_matches", { p_limit: 50 }),
    supabase.from("clubs").select("id, name, slug").eq("active", true).order("name"),
  ]);
  return <PlayBoard areas={ref.areas} sports={ref.sports} initial={(matches ?? []) as OpenMatch[]} clubs={clubs ?? []} />;
}
