// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import NewClubForm from "./NewClubForm";

const insert = vi.fn(async () => ({ error: null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({ insert }) }) }));
afterEach(() => { cleanup(); insert.mockClear(); });

// types like a person: one character at a time (each keystroke is its own change)
const typeInto = (el: HTMLElement, text: string) => { let v = ""; for (const ch of text) { v += ch; fireEvent.change(el, { target: { value: v } }); } };

describe("new club form", () => {
  it("the URL name follows the whole club name as it is typed (not just the first letter)", () => {
    render(<NewClubForm />);
    fireEvent.click(screen.getByRole("button", { name: "Add a club" }));
    typeInto(screen.getByPlaceholderText("Club name"), "Tripoli Padel Club");
    expect((screen.getByPlaceholderText(/^url-name/) as HTMLInputElement).value).toBe("tripoli-padel-club");
  });
  it("a URL name edited by hand is kept when the club name changes", () => {
    render(<NewClubForm />);
    fireEvent.click(screen.getByRole("button", { name: "Add a club" }));
    typeInto(screen.getByPlaceholderText("Club name"), "Tripoli");
    fireEvent.change(screen.getByPlaceholderText(/^url-name/), { target: { value: "tripoli-north" } });
    typeInto(screen.getByPlaceholderText("Club name"), "Tripoli Padel");
    expect((screen.getByPlaceholderText(/^url-name/) as HTMLInputElement).value).toBe("tripoli-north");
  });
});
