// @vitest-environment jsdom
/**
 * H6 (Session B's round-3 handover): after "Send sign-in email" focus was lost (document.body), so keyboard and
 * screen-reader users had to find the code field; a wrong code's message was not announced.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
const verifyOtp = vi.fn(async () => ({ error: { message: "Token has expired or is invalid", status: 403, code: "otp_expired" } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithOtp: async () => ({ error: null }), verifyOtp, signInWithOAuth: async () => ({ error: null }) } }),
}));
vi.mock("@/lib/report", () => ({ reportAuthError: vi.fn() }));
const { default: LoginForm } = await import("./LoginForm");
afterEach(cleanup);

describe("sign-in form: focus and announcements (H6)", () => {
  it("the fields are named; on the code step focus moves to the code field", async () => {
    render(<LoginForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "a@b.example" } });
    fireEvent.click(screen.getByText("Send sign-in email"));
    const code = await screen.findByRole("textbox", { name: "Sign-in code" });
    await waitFor(() => expect(document.activeElement).toBe(code));
  });
  it("a wrong code's message is announced (role=alert)", async () => {
    render(<LoginForm />);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "a@b.example" } });
    fireEvent.click(screen.getByText("Send sign-in email"));
    fireEvent.change(await screen.findByRole("textbox", { name: "Sign-in code" }), { target: { value: "12345678" } });
    fireEvent.click(screen.getByText("Continue"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/code/i);
  });
});
