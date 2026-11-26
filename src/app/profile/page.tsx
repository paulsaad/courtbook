import { redirect } from "next/navigation";
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
  // Optional, and outside allLoaded on purpose: until the photo schema is applied this call fails, and the profile
  // must still load exactly as before (initials, no photo controls).
  const { data: photoVersion, error: photoError } = await supabase.rpc("my_photo_version");
  const levels = Object.fromEntries(((lv ?? []) as { sport: string; level: number }[]).map((r) => [r.sport, r.level]));
  const isAdmin = p?.roles?.includes("admin") ?? false;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <ProfileForm
      initial={{ name: p?.name ?? "", phone: p?.phone ?? user.phone ?? "", level: p?.level ?? "", sports: p?.sports ?? [], email_notifications: p?.email_notifications ?? true }}
      next={safeNext}
      firstTime={!p?.name}
      sports={sports ?? []}
      levels={levels}
      areas={ref.areas}
      photo={photoError ? undefined : { userId: user.id, version: (photoVersion as number | null) ?? null }}
      manage={{ staffHref: isAdmin || (staffCount ?? 0) > 0 ? "/staff" : null, isAdmin, isCoach: (coachCount ?? 0) > 0, email: user.email ?? user.phone ?? "" }}
    />
  );
}
