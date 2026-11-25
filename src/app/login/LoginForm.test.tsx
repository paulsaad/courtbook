// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * After a genuine sign-in with the email code, the login form sends the person to ?next=. That must never be another
 * site (review 25 Nov): "/\evil.example" and "/<tab>/evil.example" passed the old check and resolve off-site.
 */
const replace = vi.fn();
let next = "/";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`next=${encodeURIComponent(next)}`),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithOtp: async () => ({ error: null }), verifyOtp: async () => ({ error: null }), signInWithOAuth: async () => ({ error: null }) } }),
}));
vi.mock("@/lib/report", () => ({ reportAuthError: vi.fn() }));
const { default: LoginForm } = await import("./LoginForm");

async function signIn() {
  render(<LoginForm />);
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.example" } });
  fireEvent.click(screen.getByText("Send sign-in email"));
  const code = await screen.findByPlaceholderText("12345678");
  fireEvent.change(code, { target: { value: "12345678" } });
  fireEvent.click(screen.getByText("Continue"));
  await waitFor(() => expect(replace).toHaveBeenCalled());
  return replace.mock.calls.at(-1)?.[0] as string;
}
afterEach(() => { cleanup(); replace.mockReset(); });

describe("login: where the person goes after signing in", () => {
  it("to the page they came from, on this site", async () => {
    next = "/club/batroun?date=2026-12-01";
    expect(await signIn()).toBe("/club/batroun?date=2026-12-01");
  });
  for (const attack of ["/\\evil.example", "/\t/evil.example", "//evil.example", "https://evil.example"]) {
    it(`never to another site: next=${JSON.stringify(attack)} → "/"`, async () => {
      next = attack;
      const target = await signIn();
      expect(target).toBe("/");
      expect(new URL(target, "https://courtbook.example").host).toBe("courtbook.example");
    });
  }
});
