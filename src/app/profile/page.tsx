import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ProfileForm from "./ProfileForm";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/profile");
  const { data: p } = await supabase.from("profiles").select("name, phone, level, sports, email_notifications").eq("id", user.id).single();
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <ProfileForm
      initial={{ name: p?.name ?? "", phone: p?.phone ?? user.phone ?? "", level: p?.level ?? "", sports: p?.sports ?? [], email_notifications: p?.email_notifications ?? true }}
      next={safeNext}
      firstTime={!p?.name}
    />
  );
}
