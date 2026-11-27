// Review 66-4 (27 Nov): the catalogue's refusals reach the player as words, not as a raw code or a foreign-key error.
import { describe, expect, it } from "vitest";
import { friendlyError } from "@/lib/types";

describe("sports catalogue refusals", () => {
  it("a switched-off sport and an unknown code each have their own message", () => {
    expect(friendlyError("sport_inactive")).toBe("That sport isn't available any more. Choose another sport.");
    expect(friendlyError("unknown_sport")).toBe("That sport isn't available. Choose a sport from the list.");
    expect(friendlyError("sport_inactive")).not.toBe(friendlyError("\u0000unrecognised"));
  });
});
