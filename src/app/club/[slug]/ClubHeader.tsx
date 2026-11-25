import Link from "next/link";
import { directionsUrl } from "@/lib/places";
import FavouriteHeart from "@/components/FavouriteHeart";

export type ClubHead = {
  id: string; lat: number | string | null; lng: number | string | null;
  name: string; slug: string; open_time: string; close_time: string; location_url: string | null;
  town: string | null; district: string | null; sports: string[]; priceMin: number | null; priceMax: number | null;
  is_demo?: boolean | null;
};

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
        {[club.town, club.district].filter(Boolean).join(" · ") || "Lebanon"} · {club.open_time.slice(0, 5)}–{club.close_time.slice(0, 5)}{price && <> · {price}</>}
        {directions && <> · <a className="text-action underline" href={directions} target="_blank" rel="noreferrer">Directions</a></>}
      </p>
      <nav className="mt-3 flex rounded-full border border-grid bg-white p-0.5 text-sm">
        {TABS.map(([t, label]) => (
          <Link key={t} href={`/club/${club.slug}${t}`} className={`flex-1 rounded-full py-1.5 text-center ${tab === t ? "bg-ink text-white" : ""}`}>{label}</Link>
        ))}
      </nav>
    </header>
  );
}
