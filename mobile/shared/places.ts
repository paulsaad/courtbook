/**
 * Places shared by the website and the app (copied to mobile/shared/places.ts; npm run check:shared keeps them equal).
 * Pure functions only: distances, map links, saved playing areas. Nothing here reads or sends a position.
 */

export type LatLng = { lat: number; lng: number };

/** Lebanon's database check is loose (lat 33–35, lng 35–37); points outside it are never used. */
export function clubPoint(lat: unknown, lng: unknown): LatLng | null {
  const a = typeof lat === "string" ? Number(lat) : lat;
  const b = typeof lng === "string" ? Number(lng) : lng;
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 33 || a > 35 || b < 35 || b > 37) return null;
  return { lat: a, lng: b };
}

/** Straight-line ("as the crow flies") distance in km. Good to a few metres at Lebanon's scale. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Round to 2 decimals (≈1.1 km north–south, ≈0.9 km east–west here): enough to sort clubs. */
export function coarsen(p: LatLng): LatLng {
  return { lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 };
}

/**
 * Display. The position is coarse and the distance is straight-line, so nothing finer than
 * "Under 1 km" is claimed. Screen readers get the unit in words.
 */
export function distanceLabel(km: number): { text: string; a11y: string } {
  if (!Number.isFinite(km) || km < 0) return { text: "", a11y: "" };
  if (km < 1) return { text: "Under 1 km", a11y: "under 1 kilometre away" };
  if (km < 10) {
    const v = (Math.round(km * 10) / 10).toFixed(1);
    return { text: `${v} km`, a11y: `${v} kilometres away` };
  }
  const v = String(Math.round(km));
  return { text: `${v} km`, a11y: `${v} kilometres away` };
}

/**
 * Nearest first. Clubs without usable coordinates keep their incoming order and come after every
 * club that has one — they are never given a made-up distance.
 */
export function sortByDistance<T extends { id: string }>(items: T[], points: Map<string, LatLng>, origin: LatLng):
  { item: T; km: number | null }[] {
  const withKm = items.map((item, i) => {
    const p = points.get(item.id);
    return { item, km: p ? haversineKm(origin, p) : null, i };
  });
  withKm.sort((a, b) => {
    if (a.km === null && b.km === null) return a.i - b.i;
    if (a.km === null) return 1;
    if (b.km === null) return -1;
    return a.km - b.km || a.i - b.i;
  });
  return withKm.map(({ item, km }) => ({ item, km }));
}

// ---- map links ------------------------------------------------------------------------------------

/**
 * "Directions": opens the phone's or computer's maps at the club with a route from where the player is. Google's
 * universal link works in a browser, in Google Maps and on iPhone without Google Maps (it opens the website, which
 * offers Apple Maps). Uses the exact map point when there is one, otherwise the club's own map link.
 */
export function directionsUrl(lat: unknown, lng: unknown, fallback: string | null | undefined): string | null {
  const p = clubPoint(lat, lng);
  if (p) return `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  const f = (fallback ?? "").trim();
  return /^https:\/\//i.test(f) ? f : null;
}

/**
 * Reads a map point out of a pasted map link, so club staff can correct a location by pasting the link of the right
 * spot instead of typing numbers. Understands Google Maps' forms (".../@34.4367,35.8497,17z", "?q=34.43,35.84",
 * "!3d34.4370!4d35.8500", "query=…", "ll=…") and a bare "34.4367, 35.8497". The pin ("!3d…!4d…") wins over the
 * map's centre ("@…"). Returns null when there is no usable point in Lebanon's range.
 */
export function pointFromMapLink(text: string | null | undefined): LatLng | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  const num = "(-?\\d{1,3}\\.\\d+)";
  const tries = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`[?&](?:q|query|ll|destination)=${num},\\s*${num}`),
    new RegExp(`@${num},${num}`),
    new RegExp(`^${num}\\s*,\\s*${num}$`),
  ];
  for (const re of tries) {
    const m = re.exec(decodeURIComponentSafe(s));
    if (m) { const p = clubPoint(m[1], m[2]); if (p) return p; }
  }
  return null;
}
function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

// ---- saved playing areas (0088) -------------------------------------------------------------------

/** One saved area: a governorate, optionally a district, optionally a town in it. `label`/`within` come from the server. */
export type PlayingArea = { governorate: string; district: string | null; town: string | null; label?: string; within?: string | null };
export type PlayingPrefs = { asked: boolean; areas: PlayingArea[]; last: PlayingArea | null };
export const MAX_AREAS = 10;

export function areaKey(a: Pick<PlayingArea, "governorate" | "district" | "town"> | null): string {
  return a ? [a.governorate, a.district ?? "", a.town ?? ""].join("/") : "";
}
export function sameArea(a: Pick<PlayingArea, "governorate" | "district" | "town"> | null, b: Pick<PlayingArea, "governorate" | "district" | "town"> | null): boolean {
  return areaKey(a) === areaKey(b);
}

/** Read my_playing_prefs()'s answer defensively: anything malformed becomes "nothing saved". */
export function parsePlayingPrefs(raw: unknown): PlayingPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const one = (x: unknown): PlayingArea | null => {
    const o = (x && typeof x === "object" ? x : null) as Record<string, unknown> | null;
    if (!o || typeof o.governorate !== "string") return null;
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
    return { governorate: o.governorate, district: str(o.district), town: str(o.town), label: str(o.label) ?? undefined, within: str(o.within) };
  };
  return {
    asked: r.asked === true,
    areas: Array.isArray(r.areas) ? r.areas.map(one).filter((a): a is PlayingArea => a !== null) : [],
    last: one(r.last),
  };
}

/** What a list query needs for an area: the RPCs filter by governorate or district; a town is narrowed by name. */
export function areaFilter(a: PlayingArea | null): { p_governorate: string | null; p_district: string | null; townName: string | null } {
  if (!a) return { p_governorate: null, p_district: null, townName: null };
  return { p_governorate: a.district ? null : a.governorate, p_district: a.district, townName: a.town ? a.label ?? null : null };
}

/** The body set_playing_areas expects: codes and ids only, in order, without duplicates. */
export function areasPayload(areas: PlayingArea[]): { governorate: string; district: string | null; town: string | null }[] {
  const seen = new Set<string>();
  const out: { governorate: string; district: string | null; town: string | null }[] = [];
  for (const a of areas) {
    const k = areaKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ governorate: a.governorate, district: a.district, town: a.town });
  }
  return out.slice(0, MAX_AREAS);
}

/** "Batroun" / "Batroun district" style names from the reference lists, for an area the server has not named yet. */
export function areaName(a: PlayingArea, govs: { code: string; name_en: string; districts: { code: string; name_en: string }[] }[]): string {
  if (a.label) return a.label;
  const g = govs.find((x) => x.code === a.governorate);
  const d = g?.districts.find((x) => x.code === a.district);
  return d?.name_en ?? g?.name_en ?? "Area";
}
