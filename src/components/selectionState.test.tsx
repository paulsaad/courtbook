// @vitest-environment jsdom
/**
 * Website accessibility, local pilot build at 360 px (26 Nov; Playwright accessibility tree):
 * the chosen tab on Bookings, the chosen filters on Find a game and the level-range mode were shown by
 * colour only — screen readers heard plain buttons with no state (WCAG 4.1.2). The area button read
 * "◉ All Lebanon ▾", and the level range did not announce a new range after + or −.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: async () => ({ data: [], error: null }) }) }));

import BookingsTabs from "@/app/me/BookingsTabs";
import PlayBoard from "@/app/play/PlayBoard";
import AreaPicker from "./AreaPicker";
import LevelRange from "./LevelRange";

afterEach(cleanup);
const pressed = (name: string | RegExp) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const areas = [{ code: "north", name_en: "North", name_ar: "", districts: [{ code: "batroun", name_en: "Batroun", name_ar: "" }] }] as never;

describe("selected state is announced, not only coloured", () => {
  it("Bookings tabs", () => {
    render(<BookingsTabs bookings={[]} matches={[]} past={[]} />);
    expect([pressed(/^Courts/), pressed(/^Matches/), pressed("History")]).toEqual(["true", "false", "false"]);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect([pressed(/^Courts/), pressed(/^Matches/), pressed("History")]).toEqual(["false", "false", "true"]);
  });

  it("Find a game filters", async () => {
    const sports = [{ code: "padel", name_en: "Padel", name_ar: "", sort_order: 1, active: true }] as never;
    render(<PlayBoard areas={areas} sports={sports} initial={[]} clubs={[]} />);
    expect([pressed("All sports"), pressed("Padel"), pressed("Any day"), pressed("Today"), pressed("My level")]).toEqual(["true", "false", "true", "false", "false"]);
    fireEvent.click(screen.getByRole("button", { name: "Padel" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    fireEvent.click(screen.getByRole("button", { name: "My level" }));
    await waitFor(() => expect([pressed("All sports"), pressed("Padel"), pressed("Any day"), pressed("Today"), pressed("My level")]).toEqual(["false", "true", "false", "true", "true"]));
  });

  it("the area button says what it is and where, without reading the symbols", () => {
    render(<AreaPicker areas={areas} value={{ gov: "north", district: "batroun" }} onChange={() => {}} />);
    const b = screen.getByRole("button", { name: "Area: Batroun, North" });
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("level range: the mode is announced and a new range is read out", () => {
    function Host() { const [v, setV] = useState<[number | null, number | null]>([null, null]); return <LevelRange value={v} onChange={setV} />; }
    render(<Host />);
    expect([pressed("All levels welcome"), pressed("Level range")]).toEqual(["true", "false"]);
    fireEvent.click(screen.getByRole("button", { name: "Level range" }));
    expect([pressed("All levels welcome"), pressed("Level range")]).toEqual(["false", "true"]);
    const summary = screen.getByText(/^Levels? \d/);
    expect(summary.getAttribute("aria-live")).toBe("polite");
    const before = summary.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Raise minimum" }));
    expect(summary.textContent).not.toBe(before);
  });
});
