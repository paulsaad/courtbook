import { useQuery } from "@tanstack/react-query";
import { supabase, supabaseOrigin } from "./supabase";
import { sportName } from "./days";

/**
 * Everything the club's Info tab shows, read the way the website's Info page reads it
 * (src/app/club/[slug]/info/page.tsx): the clubs row, its active courts, its price rules and its
 * photos. All of it is public (browsing needs no sign-in).
 */

/** The same seven facilities, labels and order as the website (src/components/ClubVenue.tsx). */
export const FACILITIES = [
  ["has_parking", "Parking"],
  ["has_changing_rooms", "Changing rooms"],
  ["has_showers", "Showers"],
  ["has_equipment_rental", "Equipment rental"],
  ["has_cafe", "Café"],
  ["has_floodlights", "Floodlights"],
  ["has_drinking_water", "Drinking water"],
] as const;
type FacilityKey = (typeof FACILITIES)[number][0];

export type ClubInfoRow = {
  id: string;
  name: string;
  timezone: string;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  min_booking_minutes: number;
  max_booking_minutes: number;
  cancel_cutoff_hours: number;
  booking_window_days: number;
  service_fee_usd: number | string;
  payment_mode: string | null;
  location_url: string | null;
  lat: number | string | null;
  lng: number | string | null;
  description: string | null;
  arrival_notes: string | null;
  address: string | null;
  cover_url: string | null;
  is_demo: boolean | null;
  town: { name_en: string } | null;
} & Record<FacilityKey, boolean | null>;

export type InfoCourt = { id: string; name: string; sport: string; surface: string | null };
export type InfoPriceRule = { start_time: string; end_time: string; price_usd: number | string; label: string | null; court_id: string | null; weekday_mask?: number | null };
export type InfoMedia = { id: string; kind: "cover" | "logo" | "gallery"; path: string | null; external_url: string | null; caption: string | null; sort: number; width: number | null; height: number | null };

export type ClubInfo = { club: ClubInfoRow; courts: InfoCourt[]; rules: InfoPriceRule[]; gallery: InfoMedia[] };

const CLUB_FIELDS =
  "id, name, timezone, open_time, close_time, slot_minutes, min_booking_minutes, max_booking_minutes, cancel_cutoff_hours, " +
  "booking_window_days, service_fee_usd, payment_mode, location_url, lat, lng, description, arrival_notes, address, cover_url, is_demo, " +
  FACILITIES.map(([k]) => k).join(", ") + ", town:towns(name_en)";

export function useClubInfo(clubId: string | null) {
  return useQuery({
    queryKey: ["club-info", clubId],
    enabled: !!clubId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ClubInfo> => {
      const [club, courts, rules, media] = await Promise.all([
        supabase.from("clubs").select(CLUB_FIELDS).eq("id", clubId!).eq("active", true).single(),
        supabase.from("courts").select("id, name, sport, surface").eq("club_id", clubId!).eq("active", true).order("sort"),
        supabase.from("price_rules").select("start_time, end_time, price_usd, label, court_id, weekday_mask").eq("club_id", clubId!).order("start_time"),
        supabase.from("club_media").select("id, kind, path, external_url, caption, sort, width, height").eq("club_id", clubId!).eq("kind", "gallery").order("sort"),
      ]);
      for (const r of [club, courts, rules, media]) if (r.error) throw r.error;
      return {
        club: club.data as unknown as ClubInfoRow,
        courts: (courts.data ?? []) as InfoCourt[],
        rules: (rules.data ?? []) as InfoPriceRule[],
        gallery: (media.data ?? []) as InfoMedia[],
      };
    },
  });
}

/** Cover photos for the clubs on a list, by club id (clubs without one are absent). */
export function useClubCovers(clubIds: string[]) {
  const ids = [...new Set(clubIds)].sort();
  return useQuery({
    queryKey: ["club-covers", ids.join(",")],
    enabled: ids.length > 0,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("clubs").select("id, cover_url").in("id", ids);
      if (error) throw error;
      const out = new Map<string, string>();
      for (const r of (data ?? []) as { id: string; cover_url: string | null }[]) {
        const u = imageUrl(r.cover_url);
        if (u) out.set(r.id, u);
      }
      return out;
    },
  });
}

/**
 * Where to fetch an image. Stored images live in the public club-media bucket; a cover that predates
 * managed storage keeps its own address. clubs.cover_url holds either a full address or a path on
 * the Supabase project (written by the club_media_sync_cover trigger), so a bare path is prefixed.
 */
export function imageUrl(m: { path: string | null; external_url: string | null } | string | null, origin = supabaseOrigin): string | null {
  if (m == null) return null;
  const raw = typeof m === "string" ? m : m.external_url ?? (m.path ? `/storage/v1/object/public/club-media/${m.path}` : null);
  if (!raw) return null;
  return raw.startsWith("/") ? `${origin}${raw}` : raw;
}

/**
 * Facilities in three states, as the website: yes (shown), no (listed once, quietly), and not
 * answered (left out — showing it as a no would invent an answer the club never gave).
 */
export function facilityGroups(club: Partial<Record<FacilityKey, boolean | null>>) {
  const has: string[] = [];
  const hasNot: string[] = [];
  for (const [key, label] of FACILITIES) {
    const v = club[key];
    if (v === true) has.push(label);
    else if (v === false) hasNot.push(label);
  }
  return { has, hasNot };
}

/** "No parking, showers." — the same sentence as the website, or null. */
export function missingSentence(hasNot: string[]): string | null {
  return hasNot.length ? `No ${hasNot.map((l) => l.toLowerCase()).join(", ")}.` : null;
}

/** 60 → "1 h", 90 → "1 h 30 min" (the website's fmtDur). */
export function infoDuration(m: number): string {
  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The fact-strip form: "1–2 h", "1–1.5 h", "1.5 h" when there is one length. */
export function lengthRange(min: number, max: number): string {
  const h = (m: number) => String(Math.round((m / 60) * 100) / 100);
  return min === max ? `${h(min)} h` : `${h(min)}–${h(max)} h`;
}

/** Google Maps at the club's pin when it has one, else the link the club gave, else null. */
export function mapsUrl(club: Pick<ClubInfoRow, "lat" | "lng" | "location_url">): string | null {
  if (club.lat != null && club.lng != null) return `https://www.google.com/maps/search/?api=1&query=${Number(club.lat)},${Number(club.lng)}`;
  return club.location_url || null;
}

/** "Padel · artificial grass" */
export function courtLine(c: InfoCourt): string {
  return [sportName(c.sport), c.surface].filter(Boolean).join(" · ");
}

/**
 * One row of the price list: "08:00–17:00", "Day", "$30". A rule for a single court names that
 * court ("Padel 2 only"); the website says "one court", which leaves the player guessing which.
 */
export function priceRow(r: InfoPriceRule, courts: InfoCourt[] = []): { when: string; note: string | null; price: string } {
  const court = r.court_id ? courts.find((c) => c.id === r.court_id)?.name : null;
  const note = [r.label, r.court_id ? (court ? `${court} only` : "one court") : null].filter(Boolean).join(" · ") || null;
  return { when: `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`, note, price: `$${Number(r.price_usd).toFixed(0)}` };
}

/** The sports a club offers, in court order, without repeats. */
export function clubSports(courts: InfoCourt[]): string[] {
  return [...new Set(courts.map((c) => c.sport))];
}

/**
 * "Not available: Parking, café, floodlights" — the approved Info design's wording for the facilities
 * a club said it does not have (unanswered ones are never listed).
 */
export function notAvailableSentence(hasNot: string[]): string | null {
  if (!hasNot.length) return null;
  const [first, ...rest] = hasNot;
  return `Not available: ${[first, ...rest.map((l) => l.toLowerCase())].join(", ")}`;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The days a price rule applies on (bit 0 = Monday … bit 6 = Sunday, as in the database), or null
 * for every day. Consecutive days are joined: 31 → "Mon–Fri", 96 → "Sat–Sun", 5 → "Mon, Wed".
 */
export function weekdayLabel(mask: number | null | undefined): string | null {
  if (mask == null || (mask & 127) === 127) return null;
  const on = DAYS.map((_, i) => (mask & (1 << i)) !== 0);
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    if (!on[i]) continue;
    let j = i;
    while (j + 1 < 7 && on[j + 1]) j++;
    parts.push(j - i >= 2 ? `${DAYS[i]}–${DAYS[j]}` : j === i ? DAYS[i] : `${DAYS[i]}, ${DAYS[j]}`);
    i = j;
  }
  return parts.join(", ");
}

export type RateCard = { title: string; period: string | null; court: string | null; price: string; key: string };

/**
 * One card per price rule, from the club's own rules (approved design: "Off-peak 08:00–17:00 $20 / hr").
 * The title is the club's own label when it has one ("off-peak" → "Off-peak"), otherwise the time
 * range. The period line says the times (when the title is the label) and the days when the rule is
 * not for every day. A rule for one court names it, so a single court's price is never read as the
 * club's. Club-wide rules first, then by start time.
 */
export function rateCards(rules: InfoPriceRule[], courts: InfoCourt[] = []): RateCard[] {
  return [...rules]
    .sort((a, b) => Number(!!a.court_id) - Number(!!b.court_id) || a.start_time.localeCompare(b.start_time))
    .map((r, i) => {
      const when = `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`;
      const label = r.label?.trim() ? r.label.trim()[0].toUpperCase() + r.label.trim().slice(1) : null;
      const days = weekdayLabel(r.weekday_mask);
      const court = r.court_id ? (courts.find((c) => c.id === r.court_id)?.name ?? "One court") + " only" : null;
      return {
        key: `${i}-${r.court_id ?? "all"}-${r.start_time}`,
        title: label ?? when,
        period: [label ? when : null, days].filter(Boolean).join(" · ") || null,
        court,
        price: `$${Number(r.price_usd).toFixed(0)}`,
      };
    });
}

/** The wording above the rate cards: never "pending verification" for a real club's own prices. */
export function ratesNote(isDemo: boolean | null | undefined): string {
  return isDemo
    ? "Example prices for a demo club. Rates vary by court and time. Exact price is shown when booking."
    : "Rates vary by court and time. Exact price is shown when booking.";
}

/**
 * What the court row says under its name: the surface exactly as the club wrote it ("artificial
 * grass", "clay" — the approved design keeps the database's wording). The sport is added when the name doesn't already say it ("Court 3" → "Padel · clay"), and
 * stands alone when there is no surface ("Pitch 1" → "Football").
 */
export function courtDetail(c: InfoCourt): string {
  const sport = sportName(c.sport);
  const named = c.name.toLowerCase().includes(sport.toLowerCase());
  if (!c.surface) return sport;
  return named ? c.surface : `${sport} · ${c.surface}`;
}

/** The club's photos for the gallery: the cover first, then the gallery, each image once. */
export function clubPhotos(coverUrl: string | null, gallery: InfoMedia[], clubName: string): { uri: string; key: string; label: string; caption: string | null }[] {
  const out: { uri: string; key: string; label: string; caption: string | null }[] = [];
  const seen = new Set<string>();
  const cover = imageUrl(coverUrl);
  if (cover) { out.push({ uri: cover, key: "cover", label: `${clubName}, main photo`, caption: null }); seen.add(cover); }
  gallery.forEach((m, i) => {
    const uri = imageUrl(m);
    if (!uri || seen.has(uri)) return;
    seen.add(uri);
    out.push({ uri, key: m.id, label: m.caption ?? `${clubName}, photo ${i + 1}`, caption: m.caption });
  });
  return out;
}
