import { describe, expect, it } from "vitest";
import { allLoaded, LoadError, loaded } from "./load";

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

  it("'.single() found no row' is a successful read with no data, so the page can say not found", () => {
    const r = loaded({ data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } }, "the booking");
    expect(r.data).toBeNull();
    expect(r.error).toBeNull();
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
