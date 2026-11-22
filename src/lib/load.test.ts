import { describe, expect, it } from "vitest";
import { allLoaded, isConfirmedNoRow, LoadError, loaded } from "./load";

describe("loaded / allLoaded (W1, audit B2)", () => {
  it("a successful read is returned unchanged, including an empty one", () => {
    const r = { data: [], error: null };
    expect(loaded(r, "x")).toBe(r);
    expect(loaded({ data: null, error: null, count: 0 }, "x").count).toBe(0);
  });

  it("a failed read throws, naming what could not be loaded and never the database's text", () => {
    const fail = { data: null, error: { message: "permission denied for function player_names", code: "42501" } };
    expect(() => loaded(fail, "your bookings")).toThrow(LoadError);
    expect(() => loaded(fail, "your bookings")).toThrow("Couldn't load your bookings");
    try { loaded(fail, "your bookings"); } catch (e) { expect((e as Error).message).not.toMatch(/permission|player_names/); expect((e as Error).cause).toBe(fail.error); }
  });

  // the exact answers seen on staging (PostgREST) and produced by postgrest-js 2.119 for .maybeSingle()
  const zero = { code: "PGRST116", details: "The result contains 0 rows", message: "Cannot coerce the result to a single JSON object" };
  const many = { code: "PGRST116", details: "The result contains 8 rows", message: "Cannot coerce the result to a single JSON object" };
  const manyMaybe = { code: "PGRST116", details: "Results contain 2 rows, application/vnd.pgrst.object+json requires 1 row", message: "JSON object requested, multiple (or no) rows returned" };

  it("'.single() found no row' (0 rows stated) is a successful read with no data, so the page can say not found", () => {
    const r = loaded({ data: null, error: zero }, "the booking");
    expect(r.data).toBeNull();
    expect(r.error).toBeNull();
    expect(isConfirmedNoRow({ ...zero, details: "Results contain 0 rows, application/vnd.pgrst.object+json requires 1 row" })).toBe(true);
  });

  it("several rows is a failed read, never 'not found' (W1 review)", () => {
    expect(() => loaded({ data: null, error: many }, "the booking")).toThrow(LoadError);
    expect(() => loaded({ data: null, error: manyMaybe }, "the booking")).toThrow(LoadError);
    expect(() => allLoaded([{ data: [1], error: null }, { data: null, error: many }] as const, "club")).toThrow("Couldn't load club");
  });

  it("PGRST116 with missing or unrecognised details is a failed read (ambiguous, so not assumed empty)", () => {
    for (const details of [undefined, null, "", "multiple (or no) rows", "The result contains rows", "The result contains 10 rows", "The result contains 1 row", "Some rows: The result contains 0 rows"]) {
      const err = { code: "PGRST116", details, message: "JSON object requested, multiple (or no) rows returned" };
      expect(() => loaded({ data: null, error: err }, "x"), String(details)).toThrow(LoadError);
    }
    expect(isConfirmedNoRow({ code: "PGRST117", details: "The result contains 0 rows" })).toBe(false);
  });

  it("several reads: any failure throws; all good returns them in order", () => {
    const ok1 = { data: [1], error: null }, ok2 = { data: null, error: null, count: 3 };
    expect(allLoaded([ok1, ok2] as const, "home")).toEqual([ok1, ok2]);
    expect(() => allLoaded([ok1, { data: null, error: { message: "timeout" } }] as const, "home")).toThrow("Couldn't load home");
  });

  it("values from shared loaders in the same list are passed through", () => {
    const head = { town: "Batroun" }, ref = null;
    expect(allLoaded([{ data: [1], error: null }, head, ref] as const, "club")).toEqual([{ data: [1], error: null }, head, null]);
  });
});
