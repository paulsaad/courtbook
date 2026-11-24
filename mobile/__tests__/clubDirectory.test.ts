jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
import { supabase } from "../lib/supabase";
import { fetchClubPoints, fetchDirectory } from "../lib/clubDirectory";

const rpc = supabase.rpc as jest.Mock;
const from = supabase.from as jest.Mock;
beforeEach(() => { rpc.mockReset(); from.mockReset(); });

describe("fetchDirectory — the existing club_discovery, with the manual area filters", () => {
  it("passes sport, area and a trimmed search; a district is sent alone", async () => {
    rpc.mockResolvedValueOnce({ data: [{ club_id: "c1", name: "Batroun" }], error: null });
    const rows = await fetchDirectory({ sport: "padel", governorate: "north", district: "batroun", query: "  bat " });
    expect(rpc).toHaveBeenCalledWith("club_discovery", { p_sport: "padel", p_governorate: null, p_district: "batroun", p_query: "bat" });
    expect(rows[0].id).toBe("c1");
  });
  it("blank search is no search; governorate alone when no district", async () => {
    rpc.mockResolvedValueOnce({ data: [], error: null });
    await fetchDirectory({ sport: null, governorate: "north", district: null, query: "   " });
    expect(rpc).toHaveBeenCalledWith("club_discovery", { p_sport: null, p_governorate: "north", p_district: null, p_query: null });
  });
  it("a database error is thrown to the query (shown with retry)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(fetchDirectory({ sport: null, governorate: null, district: null, query: null })).rejects.toEqual({ message: "boom" });
  });
});

describe("fetchClubPoints — public club coordinates only, nothing about the player", () => {
  function mockSelect(rows: unknown[] | null, error: unknown = null) {
    const eq = jest.fn().mockResolvedValue({ data: rows, error });
    const select = jest.fn(() => ({ eq }));
    from.mockReturnValue({ select });
    return { select, eq };
  }
  it("reads id, lat, lng of active clubs and keeps only usable points", async () => {
    const { select, eq } = mockSelect([
      { id: "ok", lat: "34.255300", lng: "35.658600" }, { id: "missing", lat: null, lng: null },
      { id: "half", lat: 34.1, lng: null }, { id: "swapped", lat: 35.65, lng: 34.25 },
    ]);
    const m = await fetchClubPoints();
    expect(from).toHaveBeenCalledWith("clubs");
    expect(select).toHaveBeenCalledWith("id, lat, lng");
    expect(eq).toHaveBeenCalledWith("active", true);
    expect([...m.keys()]).toEqual(["ok"]);
    expect(m.get("ok")).toEqual({ lat: 34.2553, lng: 35.6586 });
  });
  it("the request carries no player position", async () => {
    const { select, eq } = mockSelect([]);
    await fetchClubPoints();
    const sent = JSON.stringify([from.mock.calls, select.mock.calls, eq.mock.calls]);
    expect(sent).toBe(JSON.stringify([[["clubs"]], [["id, lat, lng"]], [["active", true]]]));
  });
  it("an error is thrown (distance then simply isn't shown)", async () => {
    mockSelect(null, { message: "timeout" });
    await expect(fetchClubPoints()).rejects.toEqual({ message: "timeout" });
  });
});
