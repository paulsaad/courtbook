import { haversineKm, sortByDistance, type LatLng } from "./nearby";

/**
 * Home / Courts club list, split into sections (docs/favourites/README.md §C):
 *   My favourite clubs → Clubs near me (location on) → Discover more clubs
 *
 * `clubs` is what the server returned for the player's filters (sport, area, search, day). Sections
 * only REORDER that list; they never add a club the filters excluded, so a favourite that doesn't
 * offer the chosen sport, or isn't in the chosen area, doesn't appear. Every club appears once.
 *
 * Modes:
 *  - browse: no area chosen, no search → all three sections;
 *  - area:   the player picked an area → favourites first, then the rest in server order; no
 *            "near me" (their chosen area wins over where the phone is);
 *  - search: the player typed a search → one list in server order; favourites only marked, never
 *            moved (an explicit search is not overridden).
 */
export type Mode = "browse" | "area" | "search";
export type Placed<T> = { club: T; km: number | null; favourite: boolean };
export type Sections<T> = {
  favourites: Placed<T>[];
  near: Placed<T>[];
  discover: Placed<T>[];
  /** favourites the current filters hide — "2 favourites don't match these filters" */
  hiddenFavourites: number;
};

export const NEAR_LIMIT = 5;
export const NEAR_RADIUS_KM = 25;

export function modeOf(f: { governorate: string | null; district: string | null; query: string | null }): Mode {
  if (f.query && f.query.trim() !== "") return "search";
  if (f.governorate || f.district) return "area";
  return "browse";
}

export function buildClubSections<T extends { id: string }>(o: {
  clubs: T[];
  favouriteIds: string[];
  points: Map<string, LatLng>;
  origin: LatLng | null;
  mode: Mode;
  nearLimit?: number;
  nearRadiusKm?: number;
}): Sections<T> {
  const fav = new Set(o.favouriteIds);
  const seen = new Set<string>();
  const unique = o.clubs.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true))); // server rows are per club, but never trust it twice
  const listed = new Set(unique.map((c) => c.id));
  const hiddenFavourites = [...fav].filter((id) => !listed.has(id)).length;
  const kmOf = (c: T) => {
    const p = o.points.get(c.id);
    return o.origin && p ? haversineKm(o.origin, p) : null;
  };
  const place = (c: T): Placed<T> => ({ club: c, km: kmOf(c), favourite: fav.has(c.id) });

  if (o.mode === "search") {
    return { favourites: [], near: [], discover: unique.map(place), hiddenFavourites };
  }

  const favClubs = unique.filter((c) => fav.has(c.id));
  const rest = unique.filter((c) => !fav.has(c.id));

  // favourites: nearest first when location is on, otherwise the order the player added them
  const favOrdered = o.origin && o.mode === "browse"
    ? sortByDistance(favClubs, o.points, o.origin).map((x) => x.item)
    : [...favClubs].sort((a, b) => o.favouriteIds.indexOf(a.id) - o.favouriteIds.indexOf(b.id));

  if (o.mode === "area" || !o.origin) {
    return { favourites: favOrdered.map(place), near: [], discover: rest.map(place), hiddenFavourites };
  }

  const limit = o.nearLimit ?? NEAR_LIMIT, radius = o.nearRadiusKm ?? NEAR_RADIUS_KM;
  const byDistance = sortByDistance(rest, o.points, o.origin);
  const near = byDistance.filter((x) => x.km !== null && x.km <= radius).slice(0, limit).map((x) => x.item);
  const nearIds = new Set(near.map((c) => c.id));
  const discover = byDistance.map((x) => x.item).filter((c) => !nearIds.has(c.id)); // nearest first, unplaced last
  return { favourites: favOrdered.map(place), near: near.map(place), discover: discover.map(place), hiddenFavourites };
}

export function hiddenFavouritesNote(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? "1 favourite doesn't match these filters" : `${n} favourites don't match these filters`;
}
