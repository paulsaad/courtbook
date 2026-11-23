"use client";

import { useRouter } from "next/navigation";
import { toggleFavourite, useFavourites } from "@/lib/favourites";
import { IconHeart } from "./Icons";

/**
 * Heart on a club (0087). Filled red when it is a favourite. Signed out: leads to sign-in and back. Before 0087 exists
 * (or while the list has not loaded) nothing is drawn, so no heart ever lies. 48 px touch target.
 */
export default function FavouriteHeart({ clubId, clubName, slug, signedIn, className = "" }: { clubId: string; clubName: string; slug: string; signedIn: boolean; className?: string }) {
  const router = useRouter();
  const fav = useFavourites(signedIn);
  if (signedIn && fav.status !== "ready") return null;
  const on = signedIn && fav.ids.has(clubId);
  const saving = fav.saving.has(clubId);
  const label = !signedIn ? `Sign in to save ${clubName} as a favourite` : on ? `Remove ${clubName} from favourites` : `Add ${clubName} to favourites`;
  return (
    <button type="button" aria-label={label} aria-pressed={signedIn ? on : undefined} disabled={saving}
      onClick={(e) => {
        e.preventDefault(); e.stopPropagation();
        if (!signedIn) { router.push(`/login?next=${encodeURIComponent(`/club/${slug}`)}`); return; }
        void toggleFavourite(clubId, !on);
      }}
      className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full disabled:opacity-60 ${className}`}>
      <IconHeart size={24} filled={on} className={on ? "text-cedar" : "text-muted"} />
    </button>
  );
}

/** The reason a save was refused, once, near the hearts. */
export function FavouriteMessage({ signedIn }: { signedIn: boolean }) {
  const fav = useFavourites(signedIn);
  return fav.message ? <p role="alert" className="mx-5 mt-2 rounded-xl bg-sand-soft px-3 py-2 text-sm">{fav.message}</p> : null;
}
