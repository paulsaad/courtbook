import { describe, expect, it } from "vitest";
import { CLOSED_TEXT, CLOSED_TITLE } from "./copy";

describe("approved closed wording (Paul, 23 Nov)", () => {
  it("title and first sentence read exactly as approved", () => {
    expect(`${CLOSED_TITLE} ${CLOSED_TEXT}`.startsWith("Your account is closed. We're processing the deletion of your data.")).toBe(true);
  });
});
