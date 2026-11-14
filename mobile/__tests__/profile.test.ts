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

describe("initials", () => {
  const { initials } = jest.requireActual("../lib/profile") as typeof import("../lib/profile");
  it("first and last name, an email, one word, nothing", () => {
    expect(initials("Paul Saad")).toBe("PS");
    expect(initials("Jean-Marc el Khoury")).toBe("JK");
    expect(initials("paul.saad@example.com")).toBe("PS");
    expect(initials("Rami")).toBe("R");
    expect(initials(null)).toBe("?");
  });
});
