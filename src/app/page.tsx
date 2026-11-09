import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

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
            <span className="text-gray-600">{user.email ?? user.phone}</span>
            <button className="underline">Sign out</button>
          </form>
        ) : (
          <Link href="/login" className="text-sm underline">Sign in</Link>
        )}
      </header>

      {error && <p className="text-sm text-red-600">Could not load clubs: {error.message}</p>}

      {clubs?.map((club) => (
        <section key={club.id} className="rounded-xl border p-4">
          <h2 className="text-lg font-medium">{club.name}</h2>
          <p className="text-sm text-gray-600">
            {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)} · {club.slot_minutes}-min slots
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {[...club.courts].sort((a, b) => a.sort - b.sort).map((c) => (
              <li key={c.id} className="flex justify-between">
                <span>{c.name}</span>
                <span className="text-gray-500">{c.sport}{c.surface ? ` · ${c.surface}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
