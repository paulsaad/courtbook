import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let isStaff = false;
  if (user) {
    const [{ data: profile }, { count }] = await Promise.all([
      supabase.from("profiles").select("roles").eq("id", user.id).single(),
      supabase.from("club_staff").select("*", { count: "exact", head: true }).eq("profile_id", user.id),
    ]);
    isStaff = (profile?.roles?.includes("admin") ?? false) || (count ?? 0) > 0;
  }

  const { data: clubs, error } = await supabase
    .from("clubs")
    .select("id, name, slug, slot_minutes, open_time, close_time, courts(id, name, sport, surface, sort)")
    .eq("active", true)
    .order("name");

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">CourtBook</h1>
        {user ? (
          <form action="/auth/signout" method="post" className="flex items-center gap-3 text-sm">
            <span className="text-muted">{user.email ?? user.phone}</span>
            <button className="underline">Sign out</button>
          </form>
        ) : (
          <Link href="/login" className="text-sm underline">Sign in</Link>
        )}
      </header>

      {error && <p className="text-sm text-red-600">Could not load clubs: {error.message}</p>}

      {user && (
        <div className="flex gap-4 text-sm">
          <Link href="/bookings" className="text-action underline">My bookings</Link>
          <Link href="/profile" className="text-action underline">Profile</Link>
        </div>
      )}

      {isStaff && (
        <Link href="/staff" className="rounded-2xl bg-action px-4 py-3.5 text-center font-medium text-white">
          Staff calendar
        </Link>
      )}

      {clubs?.map((club) => (
        <Link key={club.id} href={`/club/${club.slug}`} className="block rounded-2xl border border-grid bg-white p-5 active:bg-paper">
          <h2 className="text-lg font-medium">{club.name}</h2>
          <p className="text-sm text-muted">
            {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)} · {club.slot_minutes}-min steps
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {[...club.courts].sort((a, b) => a.sort - b.sort).map((c) => (
              <li key={c.id} className="flex justify-between">
                <span>{c.name}</span>
                <span className="text-muted">{c.sport}{c.surface ? ` · ${c.surface}` : ""}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 text-sm font-medium text-action">See availability ›</div>
        </Link>
      ))}
    </main>
  );
}
