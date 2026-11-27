import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callableClubPhone, clubPhoneFrom } from "./clubContactPhone";

// PR-9b: the club's own public contact phone, dialled only when it is a plain phone number.
describe("callableClubPhone", () => {
  it.each([
    ["+961 6 123 456", "+9616123456"], ["06 123 456", "06123456"], ["71-123-456", "71123456"], ["(06) 123.456", "06123456"],
  ])("%s → tel:%s", (raw, tel) => expect(callableClubPhone(raw)).toBe(tel));
  it.each([
    ["", ""], ["null", null], ["letters", "call 06 123 456"], ["extension", "06 123 456 ext 2"], ["too short", "12345"],
    ["too long", "+961 1234 5678 9012 3"], ["+ in the middle", "06+123456"], ["two +", "++961 6 123 456"],
  ])("%s: not dialled", (_n, raw) => expect(callableClubPhone(raw)).toBeNull());
});

describe("clubPhoneFrom (the read of clubs.contact_phone)", () => {
  it("a callable contact phone", () => expect(clubPhoneFrom({ data: { contact_phone: "06 123 456" }, error: null })).toBe("06123456"));
  it("only contact_phone counts: any other number on the row is ignored (never a person's phone)", () =>
    expect(clubPhoneFrom({ data: { contact_phone: null, phone: "+961 71 000 000" }, error: null })).toBeNull());
  it("no row, a failed read, or the column missing on an older database: null (the page shows the Info link)", () => {
    expect(clubPhoneFrom({ data: null, error: null })).toBeNull();
    expect(clubPhoneFrom({ data: null, error: { code: "42703", message: "column clubs.contact_phone does not exist" } })).toBeNull();
    expect(clubPhoneFrom({ data: null, error: { code: "08006", message: "connection lost" } })).toBeNull();
  });
  it("the app's copy is the same file", () => {
    const here = readFileSync(join(__dirname, "clubContactPhone.ts"), "utf8");
    expect(readFileSync(join(__dirname, "..", "..", "mobile", "shared", "clubContactPhone.ts"), "utf8")).toBe(here);
  });
  it("the booking page reads the club's contact phone column only, from clubs", () => {
    const page = readFileSync(join(__dirname, "..", "app", "bookings", "[id]", "page.tsx"), "utf8");
    const reads = page.match(/clubPhoneFrom\(await supabase\.from\("([a-z_]+)"\)\.select\("([^"]+)"\)/);
    expect(reads?.slice(1)).toEqual(["clubs", "contact_phone"]);
  });
});
