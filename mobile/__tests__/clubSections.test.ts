import { buildClubSections, hiddenFavouritesNote, modeOf, NEAR_LIMIT, NEAR_RADIUS_KM, type Sections } from "../lib/clubSections";
import type { LatLng } from "../lib/nearby";

// Server order (club_discovery: clubs with a free time first, then area, then name)
const clubs = ["beirut1", "batroun", "tripoli", "nocoords", "jbeil", "beirut2", "sidon", "zahle"].map((id) => ({ id }));
const points = new Map<string, LatLng>([
  ["beirut1", { lat: 33.8938, lng: 35.5018 }], ["beirut2", { lat: 33.8886, lng: 35.4955 }],
  ["batroun", { lat: 34.2553, lng: 35.6586 }], ["tripoli", { lat: 34.4367, lng: 35.8497 }],
  ["jbeil", { lat: 34.1208, lng: 35.6481 }], ["sidon", { lat: 33.5571, lng: 35.3729 }], ["zahle", { lat: 33.8463, lng: 35.902 }],
]);
const ATBATROUN: LatLng = { lat: 34.25, lng: 35.66 };
const ids = (s: Sections<{ id: string }>) => ({
  favourites: s.favourites.map((x) => x.club.id), near: s.near.map((x) => x.club.id), discover: s.discover.map((x) => x.club.id),
});
const all = (s: Sections<{ id: string }>) => [...s.favourites, ...s.near, ...s.discover].map((x) => x.club.id);

describe("modeOf", () => {
  it("search beats area beats browse; blank search is no search", () => {
    expect(modeOf({ governorate: "north", district: null, query: "bat" })).toBe("search");
    expect(modeOf({ governorate: "north", district: null, query: "  " })).toBe("area");
    expect(modeOf({ governorate: null, district: "batroun", query: null })).toBe("area");
    expect(modeOf({ governorate: null, district: null, query: null })).toBe("browse");
  });
});

describe("browse, location on: favourites → near me → discover", () => {
  const s = buildClubSections({ clubs, favouriteIds: ["sidon", "jbeil"], points, origin: ATBATROUN, mode: "browse" });

  it("every club once, none lost, none added", () => {
    expect(all(s).sort()).toEqual(clubs.map((c) => c.id).sort());
    expect(new Set(all(s)).size).toBe(clubs.length);
  });
  it("favourites first, nearest first when location is on", () => {
    expect(ids(s).favourites).toEqual(["jbeil", "sidon"]);
    expect(s.favourites.every((x) => x.favourite)).toBe(true);
  });
  it("near me: non-favourites within 25 km, nearest first", () => {
    expect(NEAR_RADIUS_KM).toBe(25);
    expect(ids(s).near).toEqual(["batroun"]); // jbeil is a favourite (shown above); tripoli is ~26 km
  });
  it("discover: the rest nearest first, the club without coordinates last (never a made-up distance)", () => {
    expect(ids(s).discover.at(-1)).toBe("nocoords");
    expect(s.discover.at(-1)?.km).toBeNull();
    const kms = s.discover.filter((x) => x.km !== null).map((x) => x.km!);
    expect(kms).toEqual([...kms].sort((a, b) => a - b));
  });
});

describe("near me radius and limit", () => {
  it("only clubs within the radius; at most NEAR_LIMIT", () => {
    const s = buildClubSections({ clubs, favouriteIds: [], points, origin: ATBATROUN, mode: "browse", nearRadiusKm: 30 });
    expect(ids(s).near).toEqual(["batroun", "jbeil", "tripoli"]);
    for (const x of s.near) expect(x.km!).toBeLessThanOrEqual(30);
    const many = buildClubSections({ clubs, favouriteIds: [], points, origin: ATBATROUN, mode: "browse", nearRadiusKm: 500 });
    expect(many.near).toHaveLength(NEAR_LIMIT);
  });
  it("nothing within the radius → no near section, everything in discover by distance", () => {
    const far = buildClubSections({ clubs, favouriteIds: [], points, origin: { lat: 48.85, lng: 2.35 }, mode: "browse" });
    expect(far.near).toEqual([]);
    expect(far.discover).toHaveLength(clubs.length);
  });
});

describe("browse, location off", () => {
  const s = buildClubSections({ clubs, favouriteIds: ["sidon", "jbeil"], points, origin: null, mode: "browse" });
  it("favourites in the order the player added them (newest first), no near section", () => {
    expect(ids(s).favourites).toEqual(["sidon", "jbeil"]);
    expect(s.near).toEqual([]);
  });
  it("discover keeps the server's order and shows no distances", () => {
    expect(ids(s).discover).toEqual(["beirut1", "batroun", "tripoli", "nocoords", "beirut2", "zahle"]);
    expect(s.discover.every((x) => x.km === null)).toBe(true);
  });
});

describe("an explicit choice is never overridden", () => {
  it("area chosen: favourites in that area first, the rest in server order, no 'near me' even with location on", () => {
    const inArea = clubs.filter((c) => ["beirut1", "beirut2"].includes(c.id)); // the server already filtered
    const s = buildClubSections({ clubs: inArea, favouriteIds: ["beirut2", "batroun"], points, origin: ATBATROUN, mode: "area" });
    expect(ids(s)).toEqual({ favourites: ["beirut2"], near: [], discover: ["beirut1"] });
    expect(s.hiddenFavourites).toBe(1);
  });
  it("search: one list in the server's order, favourites marked but not moved", () => {
    const s = buildClubSections({ clubs, favouriteIds: ["zahle"], points, origin: ATBATROUN, mode: "search" });
    expect(ids(s)).toEqual({ favourites: [], near: [], discover: clubs.map((c) => c.id) });
    expect(s.discover.find((x) => x.club.id === "zahle")?.favourite).toBe(true);
    expect(s.discover[0].km).not.toBeNull(); // distance still shown, order untouched
  });
  it("sport filter: a favourite that doesn't offer the sport isn't in the list, so isn't shown", () => {
    const padelOnly = clubs.filter((c) => c.id !== "jbeil");
    const s = buildClubSections({ clubs: padelOnly, favouriteIds: ["jbeil"], points, origin: null, mode: "browse" });
    expect(s.favourites).toEqual([]);
    expect(s.hiddenFavourites).toBe(1);
    expect(hiddenFavouritesNote(s.hiddenFavourites)).toBe("1 favourite doesn't match these filters");
  });
});

describe("robustness", () => {
  it("a club repeated by the server appears once", () => {
    const s = buildClubSections({ clubs: [{ id: "a" }, { id: "a" }, { id: "b" }], favouriteIds: ["a"], points: new Map(), origin: null, mode: "browse" });
    expect(all(s)).toEqual(["a", "b"]);
  });
  it("no coordinates anywhere, location on: nothing near, server order kept", () => {
    const s = buildClubSections({ clubs, favouriteIds: [], points: new Map(), origin: ATBATROUN, mode: "browse" });
    expect(s.near).toEqual([]);
    expect(ids(s).discover).toEqual(clubs.map((c) => c.id));
  });
  it("favourites of clubs no longer listed (inactive, filtered) are counted, not shown", () => {
    const s = buildClubSections({ clubs, favouriteIds: ["gone1", "gone2", "batroun"], points, origin: null, mode: "browse" });
    expect(ids(s).favourites).toEqual(["batroun"]);
    expect(hiddenFavouritesNote(s.hiddenFavourites)).toBe("2 favourites don't match these filters");
    expect(hiddenFavouritesNote(0)).toBeNull();
  });
  it("empty list", () => {
    expect(buildClubSections({ clubs: [], favouriteIds: [], points, origin: ATBATROUN, mode: "browse" })).toEqual({ favourites: [], near: [], discover: [], hiddenFavourites: 0 });
  });
});
