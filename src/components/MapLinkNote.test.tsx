// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
const { MapLinkNote } = await import("./ClubSettings");
const { linkWithoutPoint } = await import("@/lib/places");

afterEach(cleanup);
describe("club location: a map link without the point (onboarding audit)", () => {
  it("a short share link: says it has no point and how to get it", () => {
    render(<MapLinkNote link="https://maps.app.goo.gl/AbC123xyz" hasPoint={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/short share link, which doesn't include the map point/);
    expect(screen.getByRole("status").textContent).toMatch(/Latitude and Longitude/);
  });
  it("a place link without numbers: says so", () => {
    render(<MapLinkNote link="https://www.google.com/maps/place/Batroun+Padel" hasPoint={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/doesn't include the map point/);
  });
  it("a long link with the point, an empty link, or a point already typed: nothing", () => {
    render(<MapLinkNote link="https://www.google.com/maps/place/X/@34.2553,35.6586,17z" hasPoint={false} />);
    render(<MapLinkNote link="" hasPoint={false} />);
    render(<MapLinkNote link="https://maps.app.goo.gl/AbC" hasPoint />);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("classifies links", () => {
    expect(linkWithoutPoint("https://goo.gl/maps/xyz")).toBe("short");
    expect(linkWithoutPoint("https://maps.app.goo.gl/xyz")).toBe("short");
    expect(linkWithoutPoint("https://www.google.com/maps?q=34.25,35.65")).toBeNull();
    expect(linkWithoutPoint("Batroun, near the port")).toBe("other");
    expect(linkWithoutPoint("  ")).toBeNull();
  });
});

describe("club settings form fields have names (onboarding audit, screen readers)", () => {
  it("price rule and court inputs are labelled, and day buttons say whether they are on", async () => {
    const ClubSettings = (await import("./ClubSettings")).default;
    render(<ClubSettings club={{ id: "c", name: "Club", slug: "club", active: false, service_fee_usd: 1, open_time: "08:00", close_time: "23:00", slot_minutes: 30, min_booking_minutes: 60, max_booking_minutes: 180, cancel_cutoff_hours: 6, hold_minutes: 10, booking_window_days: 14, location_url: null, town_id: null, lat: null, lng: null } as never}
      courts={[]} rules={[]} staff={[]} coaches={[]} isAdmin={false} backHref="/" areas={[]} sports={[{ code: "padel", name_en: "Padel" } as never]} town={null} media={[]} readiness={null} />);
    for (const name of ["Price from", "Price until", "Price per hour in dollars", "Which courts", "Label (optional)", "Court name", "Sport", "Surface (optional)"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Monday" }).getAttribute("aria-pressed")).toBe("true");
  });
});
