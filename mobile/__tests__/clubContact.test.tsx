jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn(), from: jest.fn() } }));
import { contactFrom } from "../lib/clubInfo";

describe("club contact (0081)", () => {
  it("shows phone and email when the club has them", () => {
    expect(contactFrom({ data: { contact_phone: "+961 6 123 456", contact_email: null }, error: null })).toEqual({ contact_phone: "+961 6 123 456", contact_email: null });
  });
  it("no contact recorded: nothing shown", () => {
    expect(contactFrom({ data: { contact_phone: null, contact_email: null }, error: null })).toBeNull();
  });
  it("before 0081 (columns missing): nothing shown, the screen still works", () => {
    expect(contactFrom({ data: null, error: { code: "42703", message: "column clubs.contact_phone does not exist" } })).toBeNull();
  });
  it("any other failure is a failed load, not 'no contact'", () => {
    expect(() => contactFrom({ data: null, error: { code: "08006", message: "connection lost" } })).toThrow();
  });
});
