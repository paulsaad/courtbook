jest.mock("../lib/supabase", () => ({ supabase: { from: jest.fn() }, supabaseOrigin: "https://ref.supabase.co" }));
import { feeSummary } from "@shared/fees";
import { clubSports, courtLine, facilityGroups, imageUrl, infoDuration, lengthRange, mapsUrl, missingSentence, priceRow } from "../lib/clubInfo";

describe("club info", () => {
  test("facilities: yes shown, no listed once, unanswered left out", () => {
    const g = facilityGroups({ has_parking: true, has_showers: false, has_cafe: null, has_floodlights: true, has_drinking_water: false });
    expect(g.has).toEqual(["Parking", "Floodlights"]);
    expect(g.hasNot).toEqual(["Showers", "Drinking water"]);
    expect(missingSentence(g.hasNot)).toBe("No showers, drinking water.");
    expect(missingSentence([])).toBeNull();
    expect(facilityGroups({})).toEqual({ has: [], hasNot: [] });
  });

  test("image addresses: stored path, path-only cover, external cover", () => {
    expect(imageUrl({ path: "c1/a.webp", external_url: null })).toBe("https://ref.supabase.co/storage/v1/object/public/club-media/c1/a.webp");
    expect(imageUrl("/storage/v1/object/public/club-media/c1/cover.webp")).toBe("https://ref.supabase.co/storage/v1/object/public/club-media/c1/cover.webp");
    expect(imageUrl("https://example.com/x.jpg")).toBe("https://example.com/x.jpg");
    expect(imageUrl({ path: null, external_url: "https://example.com/y.jpg" })).toBe("https://example.com/y.jpg");
    expect(imageUrl(null)).toBeNull();
  });

  test("maps: the pin first, then the club's link, else nothing", () => {
    expect(mapsUrl({ lat: "34.255", lng: 35.66, location_url: "https://maps.app/x" })).toBe("https://www.google.com/maps/dir/?api=1&destination=34.255,35.66");   // a route, from the exact point
    expect(mapsUrl({ lat: null, lng: null, location_url: "https://maps.app/x" })).toBe("https://maps.app/x");
    expect(mapsUrl({ lat: null, lng: 35, location_url: "" })).toBeNull();
  });

  test("durations as the website writes them, and the compact fact form", () => {
    expect(infoDuration(60)).toBe("1 h");
    expect(infoDuration(90)).toBe("1 h 30 min");
    expect(lengthRange(60, 120)).toBe("1–2 h");
    expect(lengthRange(60, 90)).toBe("1–1.5 h");
    expect(lengthRange(90, 90)).toBe("1.5 h");
  });

  test("price rows and courts", () => {
    expect(priceRow({ start_time: "08:00:00", end_time: "17:00:00", price_usd: "30.00", label: "Day", court_id: null })).toEqual({ when: "08:00–17:00", note: "Day", price: "$30" });
    expect(priceRow({ start_time: "17:00:00", end_time: "23:00:00", price_usd: 40, label: null, court_id: "k" }).note).toBe("one court");
    expect(priceRow({ start_time: "17:00:00", end_time: "23:00:00", price_usd: 40, label: "Evening", court_id: "k" }, [{ id: "k", name: "Padel 2", sport: "padel", surface: null }]).note).toBe("Evening · Padel 2 only");
    expect(courtLine({ id: "1", name: "Court 1", sport: "padel", surface: "artificial grass" })).toBe("Padel · artificial grass");
    expect(courtLine({ id: "2", name: "Court 2", sport: "tennis", surface: null })).toBe("Tennis");
    expect(clubSports([{ id: "1", name: "a", sport: "padel", surface: null }, { id: "2", name: "b", sport: "tennis", surface: null }, { id: "3", name: "c", sport: "padel", surface: null }])).toEqual(["padel", "tennis"]);
  });

  test("pay-at-the-club clubs promise no fee (shared with the website)", () => {
    expect(feeSummary("at_desk", 1)).toEqual({ fee: "None", payment: "Pay the court at the club when you arrive." });
    expect(feeSummary("simulated", "1.00").payment).toBe("Demo payment — no real money is charged.");
  });
});

import { clubPhotos, courtDetail, notAvailableSentence, rateCards, ratesNote, weekdayLabel } from "../lib/clubInfo";

describe("club info, approved design (2026-11-16)", () => {
  const courts = [
    { id: "k1", name: "Padel 1", sport: "padel", surface: "artificial grass" },
    { id: "k2", name: "Court 3", sport: "padel", surface: "clay" },
    { id: "k3", name: "Pitch 1", sport: "football", surface: null },
  ];

  test("rate cards come from the club's rules: label, times, days, court; club-wide first", () => {
    const cards = rateCards([
      { start_time: "17:00:00", end_time: "23:00:00", price_usd: "34.00", label: null, court_id: "k2", weekday_mask: 96 },
      { start_time: "17:00:00", end_time: "23:00:00", price_usd: "30.00", label: "peak", court_id: null, weekday_mask: 127 },
      { start_time: "08:00:00", end_time: "17:00:00", price_usd: 20, label: "off-peak", court_id: null },
    ], courts);
    expect(cards.map((c) => [c.title, c.period, c.court, c.price])).toEqual([
      ["Off-peak", "08:00–17:00", null, "$20"],
      ["Peak", "17:00–23:00", null, "$30"],
      ["17:00–23:00", "Sat, Sun", "Court 3 only", "$34"],
    ]);
    expect(rateCards([])).toEqual([]);
  });

  test("weekdays: every day says nothing; runs and single days read naturally", () => {
    expect(weekdayLabel(127)).toBeNull();
    expect(weekdayLabel(null)).toBeNull();
    expect(weekdayLabel(31)).toBe("Mon–Fri");
    expect(weekdayLabel(96)).toBe("Sat, Sun");
    expect(weekdayLabel(5)).toBe("Mon, Wed");
    expect(weekdayLabel(0b1011011)).toBe("Mon, Tue, Thu, Fri, Sun");
  });

  test("a real club's prices are never called unverified; a demo club's are examples", () => {
    expect(ratesNote(false)).toBe("Rates vary by court and time. Exact price is shown when booking.");
    expect(ratesNote(true)).toMatch(/^Example prices for a demo club\./);
    expect(ratesNote(false)).not.toMatch(/verif/i);
  });

  test("court detail: the surface as written; the sport when the name doesn't say it", () => {
    expect(courtDetail(courts[0])).toBe("artificial grass");
    expect(courtDetail(courts[1])).toBe("Padel · clay");
    expect(courtDetail(courts[2])).toBe("Football");
  });

  test("facilities the club does not have", () => {
    expect(notAvailableSentence(["Parking", "Café", "Floodlights"])).toBe("Not available: Parking, café, floodlights");
    expect(notAvailableSentence([])).toBeNull();
  });

  test("photos: cover first, then the gallery, each image once", () => {
    const g = [
      { id: "g1", kind: "gallery" as const, path: "c/cover.webp", external_url: null, caption: null, sort: 0, width: null, height: null },
      { id: "g2", kind: "gallery" as const, path: "c/2.webp", external_url: null, caption: "Courts", sort: 1, width: null, height: null },
    ];
    const ph = clubPhotos("/storage/v1/object/public/club-media/c/cover.webp", g, "Club");
    expect(ph.map((p) => p.key)).toEqual(["cover", "g2"]);
    expect(ph[1].label).toBe("Courts");
    expect(clubPhotos(null, [], "Club")).toEqual([]);
  });
});
