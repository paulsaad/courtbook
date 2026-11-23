/**
 * Nearby discovery — pure logic, no native module (docs/favourites/README.md §B).
 *
 * Privacy rule: the player's position never leaves the phone. Distances are computed here, against
 * club coordinates that are already public (clubs.lat / clubs.lng). The position is rounded to about
 * a kilometre as soon as it is read, kept in memory only, and never written to storage, logs or the
 * server. The only thing remembered between launches is the player's CHOICE to use location.
 *
 * Permission rule: nothing here asks for location on launch. `resumeNearby` only reads the current
 * permission; only `enableNearby`, called from the player's own tap on "Use my location", may ask.
 *
 * The device side is behind `LocationProvider` so this file needs no native dependency; the
 * expo-location adapter is added when screens are built (it is a native change: new build).
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

// ---- location state -------------------------------------------------------------------------------

export type Permission = "granted" | "denied" | "undetermined";
export interface LocationProvider {
  /** Current permission, without asking. */
  permission(): Promise<{ status: Permission; canAskAgain: boolean }>;
  /** Shows the system prompt (only from the player's tap). */
  request(): Promise<{ status: Permission; canAskAgain: boolean }>;
  /** One position fix; rejects on timeout, services off, or any device error. */
  current(timeoutMs: number): Promise<LatLng>;
  servicesEnabled(): Promise<boolean>;
}

export type LocationState =
  | { status: "off" }
  | { status: "on"; point: LatLng; at: number }
  | { status: "denied"; canAskAgain: boolean }
  | { status: "unavailable"; reason: "services_off" | "timeout" | "error" };

export const FIX_TIMEOUT_MS = 8_000;
/** A fix older than this is refreshed when the screen comes back (no background tracking). */
export const FIX_MAX_AGE_MS = 10 * 60_000;

async function fix(p: LocationProvider, now: () => number): Promise<LocationState> {
  if (!(await p.servicesEnabled().catch(() => false))) return { status: "unavailable", reason: "services_off" };
  try {
    const pt = await p.current(FIX_TIMEOUT_MS);
    // a player abroad is still a valid position (every club is then simply far away)
    const ok = Number.isFinite(pt?.lat) && Number.isFinite(pt?.lng) && Math.abs(pt.lat) <= 90 && Math.abs(pt.lng) <= 180;
    if (!ok) return { status: "unavailable", reason: "error" };
    return { status: "on", point: coarsen(pt), at: now() };
  } catch (e) {
    return { status: "unavailable", reason: /time(d)? ?out/i.test(String((e as Error)?.message ?? e)) ? "timeout" : "error" };
  }
}

/** The player tapped "Use my location": the only path that may show the system prompt. */
export async function enableNearby(p: LocationProvider, now: () => number = Date.now): Promise<LocationState> {
  let perm = await p.permission().catch(() => ({ status: "denied" as Permission, canAskAgain: false }));
  if (perm.status === "undetermined" || (perm.status === "denied" && perm.canAskAgain)) {
    perm = await p.request().catch(() => ({ status: "denied" as Permission, canAskAgain: false }));
  }
  if (perm.status !== "granted") return { status: "denied", canAskAgain: perm.canAskAgain };
  return fix(p, now);
}

/**
 * App start or screen return, when the player chose location earlier. Never asks: if permission
 * was withdrawn in Settings, nearby quietly turns off and manual areas carry on.
 */
export async function resumeNearby(p: LocationProvider, wanted: boolean, now: () => number = Date.now): Promise<LocationState> {
  if (!wanted) return { status: "off" };
  const perm = await p.permission().catch(() => ({ status: "denied" as Permission, canAskAgain: false }));
  if (perm.status !== "granted") return { status: "off" };
  return fix(p, now);
}

export function needsRefresh(s: LocationState, now: number = Date.now()): boolean {
  return s.status === "on" && now - s.at > FIX_MAX_AGE_MS;
}

/** One line under the area picker; null when nothing needs saying. */
export function locationNote(s: LocationState): string | null {
  switch (s.status) {
    case "denied":
      return s.canAskAgain
        ? "Location is off. Choose an area instead, or tap Use my location to try again."
        : "Location is turned off for CourtBook in your phone's Settings. Choose an area instead.";
    case "unavailable":
      return s.reason === "services_off"
        ? "Location services are off on this phone. Choose an area instead."
        : "We couldn't find your location just now. Choose an area instead, or try again.";
    default:
      return null;
  }
}

// ---- remembered choice (never coordinates) ----------------------------------------------------------

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export type DiscoveryPrefs = { useLocation: boolean; governorate: string | null; district: string | null };
export const DEFAULT_PREFS: DiscoveryPrefs = { useLocation: false, governorate: null, district: null };
const PREFS_KEY = "discovery_prefs_v1";
const CODE = /^[a-z0-9-]{1,40}$/;

/** Anything unreadable falls back to the defaults (location off, all Lebanon). */
export async function loadPrefs(store: KeyValueStore): Promise<DiscoveryPrefs> {
  try {
    const raw = await store.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Partial<DiscoveryPrefs>;
    const code = (x: unknown) => (typeof x === "string" && CODE.test(x) ? x : null);
    return { useLocation: v.useLocation === true, governorate: code(v.governorate), district: code(v.district) };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Stores exactly three fields; a position can't be stored by construction. */
export async function savePrefs(store: KeyValueStore, p: DiscoveryPrefs): Promise<void> {
  const clean: DiscoveryPrefs = { useLocation: p.useLocation === true, governorate: p.governorate, district: p.district };
  await store.setItem(PREFS_KEY, JSON.stringify(clean));
}
