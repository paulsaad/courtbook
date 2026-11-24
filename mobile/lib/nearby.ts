/**
 * Nearby discovery — pure logic, no native module (docs/favourites/README.md §B).
 *
 * Privacy rule: the player's position never leaves the phone. Distances are computed here, against
 * club coordinates that are already public (clubs.lat / clubs.lng). The position is rounded to about
 * a kilometre as soon as it is read, kept in memory only, and never written to storage, logs or the
 * server. The only thing remembered between launches is the player's CHOICE to use location.
 *
 * Permission rule: nothing here asks for location on launch. `resumeNearby` only reads the current
 * permission; only `enableNearby`, called from the player's own tap on "Near me", may ask.
 *
 * The device side is behind `LocationProvider` so this file needs no native dependency; the
 * expo-location adapter is added when screens are built (it is a native change: new build).
 */

// Distances and the club point check are shared with the website (src/lib/places.ts → @shared/places).
import { clubPoint, coarsen, distanceLabel, haversineKm, sortByDistance, type LatLng } from "@shared/places";
export { clubPoint, coarsen, distanceLabel, haversineKm, sortByDistance };
export type { LatLng };

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

/** The player tapped "Near me": the only path that may show the system prompt. */
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
        ? "Location is off. Choose an area instead, or tap Near me to try again."
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
