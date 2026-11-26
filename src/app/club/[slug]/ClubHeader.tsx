import Link from "next/link";
import { directionsUrl } from "@/lib/places";
import FavouriteHeart from "@/components/FavouriteHeart";

export type ClubHead = {
  id: string; lat: number | string | null; lng: number | string | null;
  name: string; slug: string; open_time: string; close_time: string; location_url: string | null;
  town: string | null; district: string | null; sports: string[]; priceMin: number | null; priceMax: number | null;
  is_demo?: boolean | null;
};

/** "Town · District", without saying the same name twice ("Batroun · Batroun": C1). */
export function placeLine(town: string | null, district: string | null) {
  const parts = [town, district].filter((x): x is string => !!x);
  const uniq = parts.filter((x, i) => parts.findIndex((y) => y.trim().toLowerCase() === x.trim().toLowerCase()) === i);
  return uniq.join(" · ") || "Lebanon";
}

const TABS = [["", "Book"], ["/matches", "Matches"], ["/coaches", "Coaches"], ["/info", "Info"]] as const;

export default function ClubHeader({ club, tab, signedIn = false }: { club: ClubHead; tab: "" | "/matches" | "/coaches" | "/info"; signedIn?: boolean }) {
  const directions = directionsUrl(club.lat, club.lng, club.location_url);
  const price = club.priceMin == null ? null : club.priceMin === club.priceMax ? `$${club.priceMin.toFixed(0)}/h` : `$${club.priceMin.toFixed(0)}–${club.priceMax!.toFixed(0)}/h`;
  return (
    <header className="px-4 pt-3">
      <Link href="/" className="text-sm text-muted">‹ Clubs</Link>
      <div className="mt-1 flex items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{club.name}</h1>
        <FavouriteHeart clubId={club.id} clubName={club.name} slug={club.slug} signedIn={signedIn} />
      </div>
      {/* Said in words, at the size it is read at. The cover's own badge disappears into three
          pixels once a listing scales it down, so it cannot be what carries this. */}
      {club.is_demo && (
        <p className="mt-1 inline-block rounded-full bg-sand-soft px-3 py-1 text-xs font-semibold text-sand">
          Fictional demo club — this venue does not exist
        </p>
      )}
      <p className="text-sm text-muted">
        {placeLine(club.town, club.district)} · {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)}{price && <> · {price}</>}
        {directions && <> · <a className="text-action underline" href={directions} target="_blank" rel="noreferrer">Directions</a></>}
      </p>
      {/* H8: at large text (Android 200 %) the four tabs pushed the page 47 px sideways; they now wrap onto a second row */}
      <nav className="mt-3 flex flex-wrap rounded-3xl border border-grid bg-white p-0.5 text-sm">
        {TABS.map(([t, label]) => (
          <Link key={t} href={`/club/${club.slug}${t}`} className={`min-w-0 flex-1 basis-auto rounded-full px-2 py-1.5 text-center ${tab === t ? "bg-ink text-white" : ""}`}>{label}</Link>
        ))}
      </nav>
    </header>
  );
}
