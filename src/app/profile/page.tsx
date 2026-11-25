import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safeNext";
import { createClient } from "@/lib/supabase/server";
import { allLoaded } from "@/lib/load";
import ProfileForm from "./ProfileForm";
import { loadRefDataChecked as loadRefData } from "@/lib/refData";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/profile");
  const [{ data: p }, { data: sports }, { count: staffCount }, { count: coachCount }, { data: lv }] = allLoaded(await Promise.all([
    supabase.from("profiles").select("name, phone, level, sports, email_notifications, roles").eq("id", user.id).single(),
    supabase.from("sports").select("code, name_en").eq("active", true).order("sort_order"),
    supabase.from("club_staff").select("*", { count: "exact", head: true }).eq("profile_id", user.id),
    supabase.from("coaches").select("*", { count: "exact", head: true }).eq("profile_id", user.id),
    supabase.rpc("my_levels"),
  ]), "your profile");
  const ref = await loadRefData(supabase);
  const levels = Object.fromEntries(((lv ?? []) as { sport: string; level: number }[]).map((r) => [r.sport, r.level]));
  const isAdmin = p?.roles?.includes("admin") ?? false;
  const safeNext = safeNextPath(next);
  return (
    <ProfileForm
      initial={{ name: p?.name ?? "", phone: p?.phone ?? user.phone ?? "", level: p?.level ?? "", sports: p?.sports ?? [], email_notifications: p?.email_notifications ?? true }}
      next={safeNext}
      firstTime={!p?.name}
      sports={sports ?? []}
      levels={levels}
      areas={ref.areas}
      manage={{ staffHref: isAdmin || (staffCount ?? 0) > 0 ? "/staff" : null, isAdmin, isCoach: (coachCount ?? 0) > 0, email: user.email ?? user.phone ?? "" }}
    />
  );
}
