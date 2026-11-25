"use client";

import Link from "next/link";
import { useFavourites } from "@/lib/favourites";
import FavouriteHeart from "./FavouriteHeart";

/** Home: "Your clubs" — every favourite, wherever it is (Beirut, Batroun, Tripoli…), one tap to the club. */
export default function FavouriteClubsRow({ signedIn }: { signedIn: boolean }) {
  const fav = useFavourites(signedIn);
  if (!signedIn || fav.status !== "ready" || fav.clubs.length === 0) return null;
  const clubs = fav.clubs.filter((c) => fav.ids.has(c.club_id));
  if (clubs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-labelledby="your-clubs">
      <div className="flex items-baseline justify-between"><h2 id="your-clubs" className="text-xl font-bold">Your clubs</h2><Link href="/courts" className="text-sm font-semibold text-turf">All clubs</Link></div>
      <div className="-mx-5 flex gap-3 overflow-x-auto px-5 pb-1">
        {clubs.map((c) => (
          <div key={c.club_id} className="card relative flex min-w-[200px] items-center gap-2 p-3">
            <Link href={`/club/${c.slug}`} className="flex min-w-0 flex-1 items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-turf-soft text-sm font-extrabold text-turf" aria-hidden="true">{c.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}</span>
              <span className="min-w-0"><span className="block truncate text-[15px] font-bold">{c.name}</span><span className="block truncate text-[13px] text-muted">{c.town ?? "Lebanon"}</span></span>
            </Link>
            <FavouriteHeart clubId={c.club_id} clubName={c.name} slug={c.slug} signedIn />
          </div>
        ))}
      </div>
    </section>
  );
}
