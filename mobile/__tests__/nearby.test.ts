import {
  clubPoint, coarsen, DEFAULT_PREFS, distanceLabel, enableNearby, FIX_MAX_AGE_MS, haversineKm, loadPrefs, locationNote,
  needsRefresh, resumeNearby, savePrefs, sortByDistance, type KeyValueStore, type LatLng, type LocationProvider, type Permission,
} from "../lib/nearby";

const BATROUN: LatLng = { lat: 34.2553, lng: 35.6586 };
const BEIRUT: LatLng = { lat: 33.8938, lng: 35.5018 };
const TRIPOLI: LatLng = { lat: 34.4367, lng: 35.8497 };

describe("haversineKm", () => {
  it("Batroun–Beirut ≈ 42.7 km, Batroun–Tripoli ≈ 26.7 km (straight line)", () => {
    expect(haversineKm(BATROUN, BEIRUT)).toBeCloseTo(42.7, 1);
    expect(haversineKm(BATROUN, TRIPOLI)).toBeCloseTo(26.7, 1);
  });
  it("is 0 for the same point and symmetric", () => {
    expect(haversineKm(BATROUN, BATROUN)).toBe(0);
    expect(haversineKm(BEIRUT, TRIPOLI)).toBeCloseTo(haversineKm(TRIPOLI, BEIRUT), 9);
  });
});

describe("clubPoint — only usable coordinates", () => {
  it("accepts numbers and PostgREST numeric strings", () => {
    expect(clubPoint(34.2553, 35.6586)).toEqual(BATROUN);
    expect(clubPoint("34.255300", "35.658600")).toEqual(BATROUN);
  });
  it("rejects missing, half, non-numeric and out-of-range points", () => {
    expect(clubPoint(null, null)).toBeNull();
    expect(clubPoint(34.2, null)).toBeNull();
    expect(clubPoint("abc", "35.6")).toBeNull();
    expect(clubPoint(0, 0)).toBeNull();
    expect(clubPoint(35.6586, 34.2553)).toBeNull(); // swapped lat/lng
    expect(clubPoint(NaN, 35.6)).toBeNull();
  });
});

describe("privacy: coarsen", () => {
  it("rounds to about a kilometre", () => {
    expect(coarsen({ lat: 34.255312, lng: 35.658649 })).toEqual({ lat: 34.26, lng: 35.66 });
  });
  it("moves a point by at most ~0.8 km", () => {
    const p = { lat: 34.2549, lng: 35.6549 };
    expect(haversineKm(p, coarsen(p))).toBeLessThan(0.8);
  });
});

describe("distanceLabel", () => {
  it("never claims more precision than the data has", () => {
    expect(distanceLabel(0.3)).toEqual({ text: "Under 1 km", a11y: "under 1 kilometre away" });
    expect(distanceLabel(3.44)).toEqual({ text: "3.4 km", a11y: "3.4 kilometres away" });
    expect(distanceLabel(9.96)).toEqual({ text: "10.0 km", a11y: "10.0 kilometres away" });
    expect(distanceLabel(26.7)).toEqual({ text: "27 km", a11y: "27 kilometres away" });
    expect(distanceLabel(NaN).text).toBe("");
    expect(distanceLabel(-1).text).toBe("");
  });
});

describe("sortByDistance — clubs without coordinates", () => {
  const clubs = [{ id: "nopoint1" }, { id: "beirut" }, { id: "tripoli" }, { id: "nopoint2" }, { id: "batroun" }];
  const points = new Map<string, LatLng>([["beirut", BEIRUT], ["tripoli", TRIPOLI], ["batroun", BATROUN]]);

  it("nearest first; clubs without a point come last, in their original order, with no distance", () => {
    const r = sortByDistance(clubs, points, { lat: 34.25, lng: 35.66 });
    expect(r.map((x) => x.item.id)).toEqual(["batroun", "tripoli", "beirut", "nopoint1", "nopoint2"]);
    expect(r[3].km).toBeNull();
    expect(r[4].km).toBeNull();
  });
  it("with no points at all, keeps the server order", () => {
    expect(sortByDistance(clubs, new Map(), BEIRUT).map((x) => x.item.id)).toEqual(clubs.map((c) => c.id));
  });
  it("equal distances keep the server order (stable)", () => {
    const same = new Map<string, LatLng>([["a", BEIRUT], ["b", BEIRUT]]);
    expect(sortByDistance([{ id: "b" }, { id: "a" }], same, BATROUN).map((x) => x.item.id)).toEqual(["b", "a"]);
  });
});

// ---- permission and location ------------------------------------------------------------------

function provider(o: {
  perm?: Permission; canAskAgain?: boolean; afterRequest?: Permission; services?: boolean; fix?: LatLng | Error;
}) {
  const calls = { permission: 0, request: 0, current: 0 };
  const p: LocationProvider = {
    permission: async () => { calls.permission++; return { status: o.perm ?? "undetermined", canAskAgain: o.canAskAgain ?? true }; },
    request: async () => { calls.request++; return { status: o.afterRequest ?? "granted", canAskAgain: o.canAskAgain ?? true }; },
    current: async () => { calls.current++; if (o.fix instanceof Error) throw o.fix; return o.fix ?? BATROUN; },
    servicesEnabled: async () => o.services ?? true,
  };
  return { p, calls };
}
const now = () => 1_000_000;

describe("resumeNearby (app start / screen return) never asks", () => {
  it("not chosen before → off, no permission call at all", async () => {
    const { p, calls } = provider({});
    expect(await resumeNearby(p, false, now)).toEqual({ status: "off" });
    expect(calls).toEqual({ permission: 0, request: 0, current: 0 });
  });
  it("chosen before but permission not granted now → off, and no prompt", async () => {
    for (const perm of ["undetermined", "denied"] as Permission[]) {
      const { p, calls } = provider({ perm });
      expect(await resumeNearby(p, true, now)).toEqual({ status: "off" });
      expect(calls.request).toBe(0);
    }
  });
  it("chosen before and still granted → a coarse fix, no prompt", async () => {
    const { p, calls } = provider({ perm: "granted", fix: { lat: 34.255312, lng: 35.658649 } });
    expect(await resumeNearby(p, true, now)).toEqual({ status: "on", point: { lat: 34.26, lng: 35.66 }, at: 1_000_000 });
    expect(calls.request).toBe(0);
  });
});

describe("enableNearby (the player tapped Near me)", () => {
  it("asks once when undetermined; granted → on", async () => {
    const { p, calls } = provider({ perm: "undetermined", afterRequest: "granted" });
    expect((await enableNearby(p, now)).status).toBe("on");
    expect(calls.request).toBe(1);
  });
  it("refused → denied, and the note points to areas", async () => {
    const { p } = provider({ perm: "undetermined", afterRequest: "denied", canAskAgain: true });
    const s = await enableNearby(p, now);
    expect(s).toEqual({ status: "denied", canAskAgain: true });
    expect(locationNote(s)).toBe("Location is off. Choose an area instead, or tap Near me to try again.");
  });
  it("blocked in Settings → no prompt shown (it can't be), note says Settings", async () => {
    const { p, calls } = provider({ perm: "denied", canAskAgain: false });
    const s = await enableNearby(p, now);
    expect(calls.request).toBe(0);
    expect(locationNote(s)).toBe("Location is turned off for CourtBook in your phone's Settings. Choose an area instead.");
  });
  it("location services off → unavailable, no fix attempted", async () => {
    const { p, calls } = provider({ perm: "granted", services: false });
    const s = await enableNearby(p, now);
    expect(s).toEqual({ status: "unavailable", reason: "services_off" });
    expect(calls.current).toBe(0);
    expect(locationNote(s)).toBe("Location services are off on this phone. Choose an area instead.");
  });
  it("slow GPS → timeout; any device error → error; both fall back to areas", async () => {
    expect(await enableNearby(provider({ perm: "granted", fix: new Error("Location request timed out") }).p, now))
      .toEqual({ status: "unavailable", reason: "timeout" });
    const s = await enableNearby(provider({ perm: "granted", fix: new Error("kCLErrorDomain 0") }).p, now);
    expect(s).toEqual({ status: "unavailable", reason: "error" });
    expect(locationNote(s)).toBe("We couldn't find your location just now. Choose an area instead, or try again.");
  });
  it("a garbage fix is not used", async () => {
    expect(await enableNearby(provider({ perm: "granted", fix: { lat: NaN, lng: 35 } }).p, now)).toEqual({ status: "unavailable", reason: "error" });
  });
  it("a provider that throws on the permission check counts as denied, not a crash", async () => {
    const { p } = provider({});
    p.permission = async () => { throw new Error("native module missing"); };
    expect(await enableNearby(p, now)).toEqual({ status: "denied", canAskAgain: false });
  });
  it("a player abroad still gets a position (clubs are simply far)", async () => {
    expect((await enableNearby(provider({ perm: "granted", fix: { lat: 48.8566, lng: 2.3522 } }).p, now)).status).toBe("on");
  });
});

describe("refresh and notes", () => {
  it("a fix older than 10 minutes is refreshed when the screen returns", () => {
    const s = { status: "on" as const, point: BATROUN, at: 0 };
    expect(needsRefresh(s, FIX_MAX_AGE_MS)).toBe(false);
    expect(needsRefresh(s, FIX_MAX_AGE_MS + 1)).toBe(true);
    expect(needsRefresh({ status: "off" }, 1e12)).toBe(false);
  });
  it("no note when on or off", () => {
    expect(locationNote({ status: "off" })).toBeNull();
    expect(locationNote({ status: "on", point: BATROUN, at: 0 })).toBeNull();
  });
});

describe("remembered choice — never a position", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => { data.set(k, v); } };
  };
  it("round-trips the choice and the area", async () => {
    const s = memory();
    await savePrefs(s, { useLocation: true, governorate: "north", district: "batroun" });
    expect(await loadPrefs(s)).toEqual({ useLocation: true, governorate: "north", district: "batroun" });
  });
  it("stores exactly three fields, even if handed more", async () => {
    const s = memory();
    await savePrefs(s, { useLocation: true, governorate: null, district: null, point: BATROUN } as never);
    const stored = JSON.parse([...s.data.values()][0]);
    expect(Object.keys(stored).sort()).toEqual(["district", "governorate", "useLocation"]);
    expect(JSON.stringify(stored)).not.toMatch(/34\.|35\./);
  });
  it("unreadable or tampered storage falls back to location off, all Lebanon", async () => {
    const s = memory();
    expect(await loadPrefs(s)).toEqual(DEFAULT_PREFS);
    s.data.set("discovery_prefs_v1", "{not json");
    expect(await loadPrefs(s)).toEqual(DEFAULT_PREFS);
    s.data.set("discovery_prefs_v1", JSON.stringify({ useLocation: "yes", governorate: "<script>", district: 7 }));
    expect(await loadPrefs(s)).toEqual(DEFAULT_PREFS);
    const failing: KeyValueStore = { getItem: async () => { throw new Error("keychain locked"); }, setItem: async () => {} };
    expect(await loadPrefs(failing)).toEqual(DEFAULT_PREFS);
  });
});
