import { describe, expect, it } from "vitest";
import { BLOCK_MAX_MINUTES, blockSlotOptions, bookingSlotOptions, pickSlots } from "./durations";

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

describe("block lengths are independent of booking limits", () => {
  it("any whole number of slots up to the block maximum", () => {
    expect(blockSlotOptions(club, at("10:00"), CLOSE)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(BLOCK_MAX_MINUTES / club.slot_minutes).toBe(8);
  });
  it("a 30 min block is possible where no booking is", () => {
    expect(blockSlotOptions(club, at("22:30"), CLOSE)).toEqual([1]);
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
