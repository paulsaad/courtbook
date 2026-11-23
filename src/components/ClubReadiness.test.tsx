// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ClubReadiness, { type ReadinessRow } from "./ClubReadiness";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
const rows = (missing: string[]): ReadinessRow[] =>
  ["name", "location", "contact", "hours", "courts", "prices", "prices_unambiguous", "staff", "payment"].map((item) => ({ item, ok: !missing.includes(item), detail: missing.includes(item) ? `fix ${item}` : null }));

afterEach(cleanup);
describe("club readiness checklist (M8)", () => {
  it("an incomplete hidden club cannot be published from the page", () => {
    render(<ClubReadiness clubId="c" active={false} rows={rows(["prices", "staff"])} isAdmin />);
    const b = screen.getByRole("button", { name: /Publish/ });
    expect(b.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/fix prices/)).toBeTruthy();
    expect(screen.getAllByText(/Missing:/).length).toBe(2);
  });
  it("a complete hidden club can be published by an admin", () => {
    render(<ClubReadiness clubId="c" active={false} rows={rows([])} isAdmin />);
    expect(screen.getByRole("button", { name: "Publish to players" }).hasAttribute("disabled")).toBe(false);
  });
  it("staff see the checklist but no publish control", () => {
    render(<ClubReadiness clubId="c" active={false} rows={rows([])} isAdmin={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/CourtBook publishes the club/)).toBeTruthy();
  });
  it("a visible club that became incomplete is flagged, and can be hidden", () => {
    render(<ClubReadiness clubId="c" active rows={rows(["courts"])} isAdmin />);
    expect(screen.getByText(/visible but incomplete/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide from players" })).toBeTruthy();
  });
});
