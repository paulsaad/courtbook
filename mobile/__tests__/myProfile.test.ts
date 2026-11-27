/**
 * Profile completion rules (Paul, 26 Nov): a court booking needs a name and a contact phone; only what is missing is
 * asked; international numbers (Lebanese and Swedish included) are accepted; the number is the player's own answer.
 */
import { checkDetails, detailsPatch, missingForBooking, saveProblem } from "../lib/myProfile";

jest.mock("../lib/supabase", () => ({ supabase: {} }));

describe("what a court booking still needs", () => {
  it("nothing for a complete profile — never asked again", () => {
    expect(missingForBooking({ name: "Rana Khoury", phone: "+96170123456" })).toEqual([]);
  });
  it("only the missing field", () => {
    expect(missingForBooking({ name: "Rana", phone: null })).toEqual(["phone"]);
    expect(missingForBooking({ name: null, phone: "+96170123456" })).toEqual(["name"]);
    expect(missingForBooking({ name: "  ", phone: " " })).toEqual(["name", "phone"]);
  });
  it("no profile row read yet: both", () => expect(missingForBooking(null)).toEqual(["name", "phone"]));
});

describe("checking the form", () => {
  const ok = (phone: string) => checkDetails({ name: "Rana", phone }, ["name", "phone"], true);
  it.each([
    ["Lebanese mobile, local", "70 123 456"],
    ["Lebanese mobile with 0", "03 123 456"],
    ["Lebanese landline", "06 123 456"],
    ["Lebanese, international", "+961 3 123 456"],
    ["Swedish mobile", "+46 70 123 45 67"],
    ["Swedish, 00 prefix", "0046 70 123 45 67"],
    ["German landline", "+49 7633 50623"],
  ])("%s is accepted", (_l, phone) => expect(ok(phone)).toEqual({}));
  it("a Swedish local number without the country code is refused, with what to do", () => {
    expect(ok("070-123 45 67").phone).toMatch(/start with \+ and the country code/);
  });
  it("letters or too short are refused", () => {
    expect(ok("call me").phone).toBeTruthy();
    expect(ok("12").phone).toBeTruthy();
  });
  it("name and phone are required before a booking", () => {
    expect(checkDetails({ name: " ", phone: "" }, ["name", "phone"], true)).toEqual({
      name: "Enter your name, as the club should see it.", phone: "Enter a phone number the club can reach you on.",
    });
  });
  it("when only editing, an empty phone is allowed (asked again at the next booking)", () => {
    expect(checkDetails({ name: "Rana", phone: "" }, ["name", "phone"], false)).toEqual({});
  });
  it("only the asked fields are checked", () => {
    expect(checkDetails({ name: "", phone: "+46701234567" }, ["phone"], true)).toEqual({});
  });
});

describe("what is saved", () => {
  it("the phone in international form, the name trimmed", () => {
    expect(detailsPatch({ name: "  Rana Khoury ", phone: "70 123 456" }, ["name", "phone"])).toEqual({ name: "Rana Khoury", phone: "+96170123456" });
    expect(detailsPatch({ phone: "+46 70 123 45 67" }, ["phone"])).toEqual({ phone: "+46701234567" });
  });
  it("only the asked fields (a booking never overwrites the name with nothing)", () => {
    expect(detailsPatch({ name: "", phone: "+46701234567" }, ["phone"])).toEqual({ phone: "+46701234567" });
  });
  it("sports only when given; an emptied phone is no phone", () => {
    expect(detailsPatch({ name: "R", phone: "", sports: ["padel"] }, ["name", "phone"])).toEqual({ name: "R", phone: null, sports: ["padel"] });
  });
});

describe("a failed save in words", () => {
  it("closed account (0086 lock-out)", () => expect(saveProblem({ message: "account_closed" })).toMatch(/closed/));
  it("no connection", () => expect(saveProblem({ message: "TypeError: Network request failed" })).toMatch(/connection/));
  it("anything else", () => expect(saveProblem({ message: "boom", code: "XX000" })).toMatch(/Something went wrong/));
});
