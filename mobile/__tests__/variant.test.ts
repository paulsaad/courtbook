import { BUNDLE_ID, PROJECT_REF, checkConnection, refFromUrl, variantFromAppId } from "../lib/variant";

const live = `https://${PROJECT_REF.production}.supabase.co`;
const staging = `https://${PROJECT_REF.staging}.supabase.co`;

describe("which database each app may use", () => {
  test("the live app uses the live database; the staging app uses staging", () => {
    expect(checkConnection(BUNDLE_ID.production, live)).toEqual({ ok: true, variant: "production" });
    expect(checkConnection(BUNDLE_ID.staging, staging)).toEqual({ ok: true, variant: "staging" });
  });

  test("the staging app never connects to live, and the live app never to staging", () => {
    const a = checkConnection(BUNDLE_ID.staging, live);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.message).toMatch(/CourtBook Staging app.*live database/);
    const b = checkConnection(BUNDLE_ID.production, staging);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.message).toMatch(/CourtBook app.*staging database/);
  });

  test("an unknown database or an unknown app is refused", () => {
    expect(checkConnection(BUNDLE_ID.staging, "https://aaaaaaaaaaaaaaaaaaaa.supabase.co").ok).toBe(false);
    expect(checkConnection(BUNDLE_ID.production, "https://example.com").ok).toBe(false);
    expect(checkConnection("com.someone.else", live).ok).toBe(false);
  });

  test("no native app (browser checks, tests): nothing to guard", () => {
    expect(checkConnection(null, "https://fakeproj.supabase.co")).toEqual({ ok: true, variant: null });
  });

  test("helpers", () => {
    expect(refFromUrl(`${live}/`)).toBe(PROJECT_REF.production);
    expect(refFromUrl(`${live}/rest/v1`)).toBeNull();
    expect(variantFromAppId(BUNDLE_ID.staging)).toBe("staging");
    expect(variantFromAppId("x")).toBeNull();
  });
});
