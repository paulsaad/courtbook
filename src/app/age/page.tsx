import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isMissingFunction, safeNext } from "@/lib/playerGate";
import { loaded } from "@/lib/load";
import AgeForm from "./AgeForm";

export const metadata = { title: "CourtBook is for ages 18 and over" };

/** 18+ (0080): asked once, before the first booking, game or chat. Signed-in only; nothing but the answer is kept. */
export default async function AgePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const back = safeNext(next);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/age?next=${encodeURIComponent(back)}`)}`);
  const res = await supabase.rpc("my_age_status");
  if (res.error && isMissingFunction(res.error)) redirect(back);                       // before 0080: nothing to ask
  if ((loaded(res, "this page").data as { confirmed?: boolean } | null)?.confirmed) redirect(back);
  return <AgeForm next={back} />;
}
