// @vitest-environment jsdom
/** "Before you book" on the website: only the missing fields; a valid number saved in international form; back to the selection. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let updates: unknown[] = [];
let result: { data: unknown; error: unknown } = { data: [{ id: "u1" }], error: null };
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ update: (p: unknown) => { updates.push(p); return { eq: () => ({ select: async () => result }) }; } }) }),
}));
import DetailsForm from "./DetailsForm";

const NEXT = "/club/batroun?at=2026-12-01T16:00:00.000Z&court=k1&dur=60";
beforeEach(() => { updates = []; result = { data: [{ id: "u1" }], error: null }; nav.replace.mockReset(); });
afterEach(cleanup);

describe("website details step", () => {
  it("name present: asks only the contact phone, saves it in international form and returns to the selection", async () => {
    render(<DetailsForm userId="u1" ask={["phone"]} next={NEXT} />);
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "+46 70 123 45 67" } });
    expect(screen.getByText("Saved as +46701234567")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(NEXT));
    expect(updates).toEqual([{ phone: "+46701234567" }]);
  });
  it("a Swedish local number is refused with the fix, and nothing is saved", async () => {
    render(<DetailsForm userId="u1" ask={["phone"]} next={NEXT} />);
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "070 123 45 67" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/country code/);
    expect(updates).toEqual([]); expect(nav.replace).not.toHaveBeenCalled();
  });
  it("both missing: both asked; both required", async () => {
    render(<DetailsForm userId="u1" ask={["name", "phone"]} next={NEXT} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["Enter your name, as the club should see it.", "Enter a phone number the club can reach you on."]);
    expect(updates).toEqual([]);
  });
  it.each([[{ message: "account_closed" }, /closed/], [{ message: "Failed to fetch" }, /connection/]])("a failed save says so and stays (%o)", async (error, re) => {
    result = { data: null, error };
    render(<DetailsForm userId="u1" ask={["phone"]} next={NEXT} />);
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "03 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(re);
    expect(nav.replace).not.toHaveBeenCalled();
  });
  it("an update the permissions filtered out (no row changed) is not treated as saved", async () => {
    result = { data: [], error: null };
    render(<DetailsForm userId="u1" ask={["phone"]} next={NEXT} />);
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "03 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not saved/);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
