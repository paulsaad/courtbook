import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loaded } from "@/lib/load";

// /staff → the first club this user may manage.
export default async function StaffIndex() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = loaded(await supabase.from("profiles").select("roles").eq("id", user.id).single(), "your profile");
  const isAdmin = profile?.roles?.includes("admin") ?? false;

  let slug: string | undefined;
  if (isAdmin) {
    const { data } = loaded(await supabase.from("clubs").select("slug").eq("active", true).order("name").limit(1), "the clubs");
    slug = data?.[0]?.slug;
  } else {
    const { data } = loaded(await supabase.from("club_staff").select("clubs(slug)").eq("profile_id", user.id).limit(1), "your clubs");
    slug = (data?.[0] as { clubs?: { slug: string } | null } | undefined)?.clubs?.slug;
  }
  if (!slug) {
    return (
      <main className="mx-auto max-w-md p-6 md:max-w-2xl lg:max-w-[720px]">
        <p>Your account is not staff at any club.</p>
      </main>
    );
  }
  redirect(`/staff/${slug}`);
}
