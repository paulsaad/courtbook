/**
 * Court discovery and availability, derived from club_day_slots — the same function the website
 * uses. Pure functions over its rows; no rule here decides anything the database decides.
 *
 * What a row means: on `start_at`, court `court_id` is free for `free_minutes` from that moment.
 * The function returns free starts only. A start missing between two free ones is shown as
 * "not free" — never "booked", because the gap may equally be the club being closed.
 */
export type DaySlot = {
  club_id: string; club_name: string; slug: string; town: string | null; district: string | null;
  price_from: number | null; sports: string[];
  slot_minutes: number; min_minutes: number; max_minutes: number; service_fee_usd: number;
  hold_minutes: number; cancel_cutoff_hours: number; timezone: string;
  court_id: string; court_name: string; court_sport: string; start_at: string; free_minutes: number;
  is_demo: boolean | null;
};

export type ClubDay = {
  id: string; name: string; slug: string; town: string | null; priceFrom: number | null;
  timezone: string; slotMinutes: number; minMinutes: number; maxMinutes: number;
  cancelCutoffHours: number; isDemo: boolean; courtCount: number; sports: string[];
  /** distinct free start times (ISO), earliest first */
  starts: string[];
};

export function clubsFromSlots(rows: DaySlot[]): ClubDay[] {
  const by = new Map<string, { first: DaySlot; courts: Set<string>; starts: Set<string> }>();
  for (const r of rows) {
    const c = by.get(r.club_id) ?? { first: r, courts: new Set(), starts: new Set() };
    c.courts.add(r.court_id);
    // normalised: PostgREST sends "…+00:00", the tile grid uses toISOString() ("…Z")
    if (r.free_minutes >= r.min_minutes) c.starts.add(new Date(r.start_at).toISOString());
    by.set(r.club_id, c);
  }
  const clubs = [...by.values()].map(({ first: r, courts, starts }) => ({
    id: r.club_id, name: r.club_name, slug: r.slug, town: r.town, priceFrom: r.price_from === null ? null : Number(r.price_from),
    timezone: r.timezone, slotMinutes: r.slot_minutes, minMinutes: r.min_minutes, maxMinutes: r.max_minutes,
    cancelCutoffHours: r.cancel_cutoff_hours, isDemo: r.is_demo === true, courtCount: courts.size, sports: r.sports,
    starts: [...starts].sort((a, b) => Date.parse(a) - Date.parse(b)),
  }));
  // clubs with something free first, then by earliest free time
  return clubs.sort((a, b) => {
    if (!a.starts.length !== !b.starts.length) return a.starts.length ? -1 : 1;
    return (Date.parse(a.starts[0] ?? "") || Infinity) - (Date.parse(b.starts[0] ?? "") || Infinity);
  });
}

/** Durations a player may choose at this club: min..max in slot steps, capped to a short list. */
export function durationOptions(club: Pick<ClubDay, "slotMinutes" | "minMinutes" | "maxMinutes">): number[] {
  const out: number[] = [];
  for (let m = club.minMinutes; m <= club.maxMinutes && out.length < 5; m += club.slotMinutes) out.push(m);
  return out;
}

export function durationLabel(m: number): string {
  const h = Math.floor(m / 60), r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r}`;
}

export type Tile = { start: string; freeCourts: { id: string; name: string }[] };

/** Same instant? Times arrive in more than one ISO spelling, so never compare them as text. */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && Date.parse(a) === Date.parse(b);
}

/**
 * One tile per start time on this club's grid, between its first and last free start. A court
 * counts as free at a start only if it stays free for the whole chosen duration.
 */
export function tilesFor(rows: DaySlot[], clubId: string, minutes: number): Tile[] {
  const mine = rows.filter((r) => r.club_id === clubId);
  if (mine.length === 0) return [];
  const step = mine[0].slot_minutes * 60_000;
  const times = mine.map((r) => Date.parse(r.start_at));
  const first = Math.min(...times), last = Math.max(...times);
  const tiles: Tile[] = [];
  for (let t = first; t <= last; t += step) {
    const free = mine
      .filter((r) => Date.parse(r.start_at) === t && r.free_minutes >= minutes)
      .map((r) => ({ id: r.court_id, name: r.court_name }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    tiles.push({ start: new Date(t).toISOString(), freeCourts: free });
  }
  return tiles;
}

/** Morning before 12:00, afternoon before 17:00, evening after — in the club's timezone hour. */
export function partOfDay(hour: number): "Morning" | "Afternoon" | "Evening" {
  return hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
}
