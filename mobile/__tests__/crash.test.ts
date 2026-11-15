const mockInit = jest.fn();
jest.mock("@sentry/react-native", () => ({ init: (o: unknown) => mockInit(o), wrap: (c: unknown) => c, captureException: jest.fn() }));
jest.mock("expo-updates", () => ({ updateId: "upd-1" }));
jest.mock("expo-application", () => ({ applicationId: "app.courtbook.mobile.staging", nativeApplicationVersion: "0.3.0", nativeBuildVersion: "7" }));
import type { ErrorEvent } from "@sentry/react-native";
import { maskEmails, scrubBreadcrumb, scrubEvent, startCrashReporting } from "../lib/crash";

describe("crash reports carry no personal information", () => {
  it("masks email addresses anywhere", () => {
    const e = { message: "sign-in failed for paul@example.com", extra: { list: ["a@b.co", 3], nested: { who: "x.y@courtbook.test" } } };
    expect(maskEmails(e)).toEqual({ message: "sign-in failed for [email]", extra: { list: ["[email]", 3], nested: { who: "[email]" } } });
  });

  it("drops the user, device name, server name, request body, headers, cookies and query strings", () => {
    const event = {
      message: "boom",
      user: { id: "u1", email: "p@x.com", ip_address: "1.2.3.4" },
      server_name: "Pauls-iPhone",
      request: { url: "https://x.supabase.co/rest/v1/bookings?client_token=eq.abc", method: "GET", headers: { Authorization: "Bearer t" }, cookies: { a: "b" }, data: { email: "p@x.com" } },
      contexts: { device: { name: "Paul's iPhone", model: "iPhone15,2" } },
      breadcrumbs: [
        { category: "touch", message: "Paul Saad" },
        { category: "fetch", type: "http", data: { method: "POST", url: "https://x.supabase.co/auth/v1/otp?redirect=y", status_code: 200, body: "{\"email\":\"p@x.com\"}" } },
        { category: "navigation", data: { to: "/booking/b1" } },
      ],
    } as unknown as ErrorEvent;
    const s = scrubEvent(event);
    expect(s.user).toBeUndefined();
    expect(s.server_name).toBeUndefined();
    expect(s.request).toEqual({ url: "https://x.supabase.co/rest/v1/bookings", method: "GET" });
    expect(s.contexts?.device?.name).toBeUndefined();
    expect(s.contexts?.device?.model).toBe("iPhone15,2");
    expect(s.breadcrumbs).toHaveLength(2);
    expect(s.breadcrumbs?.[0]).toEqual({ category: "fetch", type: "http", data: { method: "POST", url: "https://x.supabase.co/auth/v1/otp", status_code: 200 } });
    expect(JSON.stringify(s)).not.toMatch(/p@x\.com|Paul|Bearer|1\.2\.3\.4/);
  });

  it("drops tap breadcrumbs (they carry on-screen text)", () => {
    expect(scrubBreadcrumb({ category: "touch", message: "Emma Tester" })).toBeNull();
    expect(scrubBreadcrumb({ category: "ui.click", message: "x" })).toBeNull();
  });
});

describe("configuration", () => {
  beforeEach(() => mockInit.mockClear());

  it("is off without a DSN", () => {
    expect(startCrashReporting("")).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("tags the app (staging vs live), version, build and update; never sends default personal data", () => {
    expect(startCrashReporting("https://key@o1.ingest.sentry.io/2")).toBe(true);
    const o = mockInit.mock.calls[0][0];
    expect(o).toMatchObject({ environment: "staging", release: "courtbook@0.3.0+7", dist: "upd-1", sendDefaultPii: false, attachScreenshot: false, attachViewHierarchy: false });
  });
});
