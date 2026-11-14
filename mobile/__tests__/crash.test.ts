jest.mock("@sentry/react-native", () => ({ init: jest.fn(), wrap: (c: unknown) => c }));
jest.mock("expo-updates", () => ({ updateId: null }));
import { maskEmails } from "../lib/crash";

it("masks email addresses anywhere in a report", () => {
  const e = { message: "sign-in failed for paul@example.com", extra: { list: ["a@b.co", 3], nested: { who: "x.y@courtbook.test" } } };
  expect(maskEmails(e)).toEqual({ message: "sign-in failed for [email]", extra: { list: ["[email]", 3], nested: { who: "[email]" } } });
});

it("is off without a DSN", () => {
  const { startCrashReporting } = jest.requireActual("../lib/crash") as typeof import("../lib/crash");
  expect(startCrashReporting()).toBe(false);
});
