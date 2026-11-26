import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";
import { safeNext } from "@/lib/playerGate";
import { missingForBooking } from "@/lib/playerDetails";
import DetailsForm from "./DetailsForm";

/**
 * "Before you book": the name and/or contact phone a court booking still needs (Paul, 26 Nov; as the app's #70).
 * Asks only what is missing and goes back to `next` (the club or Courts page with the same selection). A complete
 * profile goes straight back, so it is never asked again.
 */
export default async function DetailsPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const back = safeNext((await searchParams).next);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/details?next=${encodeURIComponent(back)}`)}`);
  const { data } = loaded(await supabase.from("profiles").select("name, phone").eq("id", user.id).single(), "your details");
  const ask = missingForBooking(data as { name: string | null; phone: string | null } | null);
  if (ask.length === 0) redirect(back);
  return <DetailsForm userId={user.id} ask={ask} next={back} />;
}
