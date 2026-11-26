// @vitest-environment jsdom
/** Profile: "Contact phone" with the app's help and privacy wording; a typed number is checked and saved in international form. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
let updates: unknown[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => nav }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({ update: (p: unknown) => { updates.push(p); return { eq: async () => ({ error: null }) }; } }),
  }),
}));
import ProfileForm from "./ProfileForm";
import { PHONE_HELP, PHONE_PRIVACY } from "@/lib/playerDetails";

const manage = { staffHref: null, isAdmin: false, isCoach: false, email: "r@example.com" };
const mount = () => render(<ProfileForm initial={{ name: "", phone: "", level: "", sports: [], email_notifications: true }} next="/courts" firstTime sports={[{ code: "padel", name_en: "Padel" }]} manage={manage} levels={{}} />);
beforeEach(() => { updates = []; });
afterEach(cleanup);

describe("profile form: contact phone", () => {
  it("is labelled 'Contact phone', with the app's help and privacy lines (no 'WhatsApp')", () => {
    mount();
    expect(screen.getByLabelText(/Contact phone/)).toBeTruthy();
    expect(document.body.textContent).toContain(PHONE_HELP);
    expect(document.body.textContent).toContain(PHONE_PRIVACY);
    expect(document.body.textContent).not.toMatch(/WhatsApp/);
  });
  it("saves a typed number in international form", async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: " Rana " } });
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "70 123 456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ name: "Rana", phone: "+96170123456" });
  });
  it("an incomplete number is refused before saving", async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rana" } });
    fireEvent.change(screen.getByLabelText(/Contact phone/), { target: { value: "070 123 45 67" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(document.body.textContent).toMatch(/country code/));
    expect(updates).toEqual([]);
  });
  it("the phone stays optional on the profile (the booking step asks for it)", async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Rana" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ name: "Rana", phone: null });
  });
});
