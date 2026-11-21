import { describe, expect, it } from "vitest";
import { matchBookings } from "./findBooking";
import type { Booking } from "@/lib/types";

const b = (id: string, start: string, guest: string | null, phone: string | null, player: string | null = null, contact: string | null = null): Booking => ({
  id, court_id: "c", player_id: null, guest_name: guest, guest_phone: phone, player_name: player, contact_phone: contact,
  start_at: `2099-01-12T${start}:00.000Z`, end_at: `2099-01-12T${start}:00.000Z`, status: "confirmed", source: "staff", credit_tx_id: null, price_usd: 0, fee_usd: 0,
});
const rows = [b("1", "10:00", "Rami Haddad", "+961 3 123 456"), b("2", "08:00", null, null, "Maya Khoury", "70-999-888"), b("3", "12:00", "Ramzi", null)];

describe("matchBookings (find a booking on this day)", () => {
  it("names: any part, any case, two characters or more, in start order", () => {
    expect(matchBookings(rows, "ram").map((x) => x.id)).toEqual(["1", "3"]);
    expect(matchBookings(rows, "KHOURY").map((x) => x.id)).toEqual(["2"]);
    expect(matchBookings(rows, "r")).toEqual([]);
    expect(matchBookings(rows, "  ")).toEqual([]);
  });
  it("phones: three digits or more, ignoring spaces, + and dashes; the app player's phone too", () => {
    expect(matchBookings(rows, "123 4").map((x) => x.id)).toEqual(["1"]);
    expect(matchBookings(rows, "999888").map((x) => x.id)).toEqual(["2"]);
    expect(matchBookings(rows, "+961").map((x) => x.id)).toEqual(["1"]);
    expect(matchBookings(rows, "12")).toEqual([]);
  });
  it("never adds rows: only what it was given", () => {
    expect(matchBookings([], "ram")).toEqual([]);
  });
});
