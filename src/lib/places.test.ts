import { describe, expect, it } from "vitest";
import { areaFilter, areaKey, areasPayload, directionsUrl, parsePlayingPrefs, pointFromMapLink, sameArea, MAX_AREAS } from "./places";

describe("directionsUrl", () => {
  it("uses the exact map point, as a route destination", () => {
    expect(directionsUrl("34.2553", 35.6586, "https://maps.example/x")).toBe("https://www.google.com/maps/dir/?api=1&destination=34.2553,35.6586");
  });
  it("falls back to the club's own https map link; never to anything else", () => {
    expect(directionsUrl(null, null, " https://maps.app.goo.gl/abc ")).toBe("https://maps.app.goo.gl/abc");
    expect(directionsUrl(null, null, "javascript:alert(1)")).toBeNull();
    expect(directionsUrl(null, null, "http://maps.example")).toBeNull();
    expect(directionsUrl(null, null, null)).toBeNull();
  });
  it("ignores a point outside Lebanon's range or half a point", () => {
    expect(directionsUrl(48.85, 2.35, null)).toBeNull();
    expect(directionsUrl(34.2, null, null)).toBeNull();
  });
});

describe("pointFromMapLink (staff paste the link of the right spot)", () => {
  const cases: Array<[string, [number, number] | null]> = [
    ["https://www.google.com/maps/place/Club/@34.4367,35.8497,17z/data=!3m1", [34.4367, 35.8497]],
    ["https://www.google.com/maps/place/Club/@34.43,35.84,17z/data=!3m1!4b1!4m6!3m5!3d34.4370!4d35.8500", [34.437, 35.85]],
    ["https://maps.google.com/?q=33.8938,35.5018", [33.8938, 35.5018]],
    ["https://www.google.com/maps/search/?api=1&query=34.2553%2C35.6586", [34.2553, 35.6586]],
    ["34.2553, 35.6586", [34.2553, 35.6586]],
    ["https://maps.app.goo.gl/AbCd123", null],               // a short link has no numbers: staff use the long one
    ["https://www.google.com/maps/@48.8566,2.3522,12z", null], // outside Lebanon
    ["Batroun, near the old port", null],
    ["", null],
  ];
  it.each(cases)("%s", (text, want) => {
    const p = pointFromMapLink(text);
    expect(p ? [p.lat, p.lng] : null).toEqual(want);
  });
});

describe("saved playing areas", () => {
  it("reads the server's answer defensively", () => {
    expect(parsePlayingPrefs(null)).toEqual({ asked: false, areas: [], last: null });
    expect(parsePlayingPrefs({ asked: true, areas: [{ governorate: "north", district: "batroun", town: "t1", label: "Batroun", within: "Batroun" }, { nope: 1 }, "x"], last: { governorate: "beirut" } }))
      .toEqual({ asked: true, areas: [{ governorate: "north", district: "batroun", town: "t1", label: "Batroun", within: "Batroun" }], last: { governorate: "beirut", district: null, town: null, label: undefined, within: null } });
  });
  it("filters: governorate alone; district (the RPCs take one or the other); a town narrows by name", () => {
    expect(areaFilter(null)).toEqual({ p_governorate: null, p_district: null, townName: null });
    expect(areaFilter({ governorate: "beirut", district: null, town: null })).toEqual({ p_governorate: "beirut", p_district: null, townName: null });
    expect(areaFilter({ governorate: "north", district: "batroun", town: null })).toEqual({ p_governorate: null, p_district: "batroun", townName: null });
    expect(areaFilter({ governorate: "north", district: "batroun", town: "t1", label: "Batroun" })).toEqual({ p_governorate: null, p_district: "batroun", townName: "Batroun" });
  });
  it("the payload has codes only, no duplicates, at most 10", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ governorate: "north", district: `d${i}`, town: null, label: "x" }));
    expect(areasPayload([{ governorate: "beirut", district: null, town: null, label: "Beirut" }, { governorate: "beirut", district: null, town: null }]))
      .toEqual([{ governorate: "beirut", district: null, town: null }]);
    expect(areasPayload(many)).toHaveLength(MAX_AREAS);
  });
  it("compares areas by place, not by name", () => {
    expect(sameArea({ governorate: "north", district: "batroun", town: null }, { governorate: "north", district: "batroun", town: null })).toBe(true);
    expect(sameArea({ governorate: "north", district: null, town: null }, { governorate: "north", district: "batroun", town: null })).toBe(false);
    expect(areaKey(null)).toBe("");
  });
});
