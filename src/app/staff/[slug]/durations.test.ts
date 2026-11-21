import { describe, expect, it } from "vitest";
import { blockEndOptions, blockStartOptions, bookingSlotOptions, minToHhmm, pickSlots } from "./durations";

const club = { slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180 };
const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const CLOSE = at("23:00");

describe("booking lengths (Phase 9 / 0066)", () => {
  it("offers the club's minimum to maximum in grid steps", () => {
    expect(bookingSlotOptions(club, at("10:00"), CLOSE)).toEqual([2, 3, 4, 5, 6]); // 1 h … 3 h
  });
  it("never offers anything ending after closing", () => {
    expect(bookingSlotOptions(club, at("21:00"), CLOSE)).toEqual([2, 3, 4]); // 1 h, 1 h 30, 2 h
    expect(bookingSlotOptions(club, at("22:30"), CLOSE)).toEqual([]);        // 30 min left, minimum 1 h
  });
  it("follows each club's own limits and grid", () => {
    expect(bookingSlotOptions({ slot_minutes: 60, min_booking_minutes: 60, max_booking_minutes: 120 }, at("10:00"), CLOSE)).toEqual([1, 2]);
    expect(bookingSlotOptions({ slot_minutes: 30, min_booking_minutes: 90, max_booking_minutes: 90 }, at("10:00"), CLOSE)).toEqual([3]);
  });
  it("keeps a booking's current length when moving it, even outside today's limits", () => {
    expect(bookingSlotOptions(club, at("10:00"), CLOSE, 1)).toEqual([1, 2, 3, 4, 5, 6]);   // an older 30 min booking
    expect(bookingSlotOptions(club, at("10:00"), CLOSE, 8)).toEqual([2, 3, 4, 5, 6, 8]);   // an older 4 h booking
    expect(bookingSlotOptions(club, at("21:00"), CLOSE, 8)).toEqual([2, 3, 4]);            // …but not past closing
    expect(bookingSlotOptions(club, at("10:00"), CLOSE, 3)).toEqual([2, 3, 4, 5, 6]);      // already allowed: no duplicate
  });
});

describe("block times (0076): any length on the grid, up to closing or the next taken time", () => {
  const OPEN = at("08:00");
  it("ends run to closing time: a full day is offered, far beyond the old 4 h", () => {
    const ends = blockEndOptions(club, OPEN, CLOSE, []);
    expect(ends[0]).toBe(at("08:30"));
    expect(ends[ends.length - 1]).toBe(CLOSE);
    expect(ends.length).toBe(30);                                       // 08:30 … 23:00
  });
  it("ends stop at the start of the next booking, hold or block on that court", () => {
    expect(blockEndOptions(club, at("10:00"), CLOSE, [[at("12:00"), at("13:00")]]).map(minToHhmm)).toEqual(["10:30", "11:00", "11:30", "12:00"]);
    expect(blockEndOptions(club, at("10:00"), CLOSE, [[at("15:00"), at("16:00")], [at("11:00"), at("11:30")]]).map(minToHhmm)).toEqual(["10:30", "11:00"]);
  });
  it("a start inside a taken interval offers nothing; one right after it is fine", () => {
    expect(blockEndOptions(club, at("12:00"), CLOSE, [[at("12:00"), at("13:00")]])).toEqual([]);
    expect(blockEndOptions(club, at("13:00"), CLOSE, [[at("12:00"), at("13:00")]])[0]).toBe(at("13:30"));
  });
  it("a 30 min block is possible where no booking is", () => {
    expect(blockEndOptions(club, at("22:30"), CLOSE, [])).toEqual([CLOSE]);
  });
  it("follows each club's grid", () => {
    expect(blockEndOptions({ slot_minutes: 60 }, at("20:00"), CLOSE, []).map(minToHhmm)).toEqual(["21:00", "22:00", "23:00"]);
  });
  it("starts: grid slots that are free and not over", () => {
    const starts = blockStartOptions(club, OPEN, CLOSE, [[at("10:00"), at("11:00")]], -1);
    expect(starts).toContain(at("09:30"));
    expect(starts).not.toContain(at("10:00"));
    expect(starts).not.toContain(at("10:30"));
    expect(starts).toContain(at("11:00"));
    expect(starts[starts.length - 1]).toBe(at("22:30"));
  });
  it("today: a slot that has ended is not offered, the one running now is", () => {
    const starts = blockStartOptions(club, OPEN, CLOSE, [], at("14:10"));
    expect(starts[0]).toBe(at("14:00"));
    expect(blockStartOptions(club, OPEN, CLOSE, [], 24 * 60)).toEqual([]);   // a past day
  });
});

describe("pickSlots", () => {
  it("keeps the wish, else the fallback, else the first option, else nothing", () => {
    expect(pickSlots([2, 3, 4], 3, 2)).toBe(3);
    expect(pickSlots([2, 3, 4], 8, 2)).toBe(2);
    expect(pickSlots([3, 4], 8, 2)).toBe(3);
    expect(pickSlots([], 2, 2)).toBeNull();
  });
});
