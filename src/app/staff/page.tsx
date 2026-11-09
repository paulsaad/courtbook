import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// /staff → the first club this user may manage.
export default async function StaffIndex() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("roles").eq("id", user.id).single();
  const isAdmin = profile?.roles?.includes("admin") ?? false;

  let slug: string | undefined;
  if (isAdmin) {
    const { data } = await supabase.from("clubs").select("slug").eq("active", true).order("name").limit(1);
    slug = data?.[0]?.slug;
  } else {
    const { data } = await supabase.from("club_staff").select("clubs(slug)").eq("profile_id", user.id).limit(1);
    slug = (data?.[0] as { clubs?: { slug: string } | null } | undefined)?.clubs?.slug;
  }
  if (!slug) {
    return (
      <main className="mx-auto max-w-md p-6">
        <p>Your account is not staff at any club.</p>
      </main>
    );
  }
  redirect(`/staff/${slug}`);
}
