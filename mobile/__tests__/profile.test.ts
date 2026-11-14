jest.mock("../lib/supabase", () => ({ supabase: { from: jest.fn() } }));
import { firstName } from "../lib/profile";

describe("firstName", () => {
  it("greets by the first word of the profile name", () => {
    expect(firstName("Paul Saad")).toBe("Paul");
    expect(firstName("  Bol ")).toBe("Bol");
  });
  it("has nothing to greet with when there is no name", () => {
    expect(firstName(null)).toBeNull();
    expect(firstName("   ")).toBeNull();
  });
});
