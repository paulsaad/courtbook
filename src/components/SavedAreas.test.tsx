// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [{ id: "t-batroun", name_en: "Batroun" }, { id: "t-kfar", name_en: "Kfar Abida" }] }) }) }) }) }),
}));
const { AreasQuestion, SavedAreaChips, PlayingAreasEditor } = await import("./SavedAreas");
const FavouriteHeart = (await import("./FavouriteHeart")).default;
afterEach(() => { cleanup(); push.mockClear(); });

const govs = [
  { code: "beirut", name_en: "Beirut", name_ar: "", districts: [{ code: "beirut", name_en: "Beirut", name_ar: "" }] },
  { code: "north", name_en: "North", name_ar: "", districts: [{ code: "batroun", name_en: "Batroun", name_ar: "" }, { code: "tripoli", name_en: "Tripoli", name_ar: "" }] },
  { code: "south", name_en: "South", name_ar: "", districts: [] },
];

describe("first-use question (0088)", () => {
  it("is optional, allows several areas, and saves them in the order picked", async () => {
    const onSave = vi.fn(async () => {});
    render(<AreasQuestion govs={govs} onSave={onSave} onDismiss={() => {}} />);
    expect(screen.getByRole("heading").textContent).toBe("Where do you usually play?");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "North" }));
    fireEvent.click(screen.getByRole("button", { name: "Beirut" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([{ governorate: "north", district: null, town: null }, { governorate: "beirut", district: null, town: null }]));
  });
  it("'Not now' dismisses it", () => {
    const onDismiss = vi.fn();
    render(<AreasQuestion govs={govs} onSave={vi.fn()} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("saved area chips", () => {
  const prefs = { asked: true, last: null, areas: [{ governorate: "beirut", district: null, town: null, label: "Beirut" }, { governorate: "north", district: "batroun", town: "t-batroun", label: "Batroun", within: "Batroun" }] };
  it("one tap per saved area, plus All Lebanon; the current one is pressed", () => {
    const onPick = vi.fn();
    render(<SavedAreaChips prefs={prefs} govs={govs} current={{ governorate: "north", district: "batroun", town: "t-batroun" }} onPick={onPick} />);
    expect(screen.getByRole("button", { name: "Batroun" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Beirut" }));
    expect(onPick).toHaveBeenCalledWith(prefs.areas[0]);
    fireEvent.click(screen.getByRole("button", { name: "All Lebanon" }));
    expect(onPick).toHaveBeenLastCalledWith(null);
  });
  it("nothing when no areas are saved (or before 0088)", () => {
    const { container } = render(<SavedAreaChips prefs={null} govs={govs} current={null} onPick={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

describe("areas editor (profile)", () => {
  it("adds a town-level area; removes one; refuses a duplicate", async () => {
    const onSave = vi.fn(async () => {});
    const prefs = { asked: true, last: null, areas: [{ governorate: "beirut", district: null, town: null, label: "Beirut" }] };
    render(<PlayingAreasEditor govs={govs} prefs={prefs} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "north" } });
    fireEvent.change(screen.getByLabelText("District (optional)"), { target: { value: "batroun" } });
    await waitFor(() => screen.getByLabelText("Town (optional)"));
    fireEvent.change(screen.getByLabelText("Town (optional)"), { target: { value: "t-batroun" } });
    fireEvent.click(screen.getByRole("button", { name: "Add this area" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith([prefs.areas[0], { governorate: "north", district: "batroun", town: "t-batroun", label: "Batroun" }]));
    fireEvent.click(screen.getByRole("button", { name: "Remove Beirut" }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith([]));
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "beirut" } });
    expect(screen.getByRole("button", { name: "Already in your areas" })).toBeTruthy();
  });
  it("too many: says the limit", async () => {
    const onSave = vi.fn(async () => { throw new Error("too_many_areas"); });
    render(<PlayingAreasEditor govs={govs} prefs={{ asked: true, last: null, areas: [] }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Area"), { target: { value: "south" } });
    fireEvent.click(screen.getByRole("button", { name: "Add this area" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/up to 10 areas/);
  });
});

describe("favourite heart", () => {
  it("signed out: offers sign-in and comes back to the club", () => {
    render(<FavouriteHeart clubId="c1" clubName="Batroun Padel" slug="batroun" signedIn={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in to save Batroun Padel as a favourite" }));
    expect(push).toHaveBeenCalledWith("/login?next=%2Fclub%2Fbatroun");
  });
});
