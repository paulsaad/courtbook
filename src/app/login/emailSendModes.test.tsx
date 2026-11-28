// @vitest-environment jsdom
/**
 * Investigation (26 Nov): the silent staging sign-in-email failure. What the sign-in page can know, and what reaches
 * our monitoring, in Supabase Auth's two ways of sending the code email. Reproduced with the real @supabase/auth-js
 * against a local stand-in for Auth's POST /otp (no email is sent anywhere):
 *   sync (Auth's default): the SMTP failure is the request's answer, 500 "Error sending … email"; no account is made;
 *   background (EmailBackgroundSending): Auth answers 200 at once and sends afterwards; an SMTP failure is only in
 *     Auth's own log ("apitask: error running mailer…"). This is the only mode that matches 24 Nov 19:18Z
 *     (account created, 200, no mail): docs/auth-email/README.md.
 * These tests pin today's behaviour. They pass on the current code: they are evidence, not a fix.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createServer, type Server } from "node:http";
import { AuthClient } from "@supabase/supabase-js";

const mode = vi.hoisted(() => ({ value: "background" as "background" | "sync", otpCalls: 0, mailFailures: 0, url: "" }));
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/auth/v1/otp")) {
      mode.otpCalls++;
      mode.mailFailures++;                                   // in both modes the SMTP send fails
      if (mode.value === "sync") { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ code: 500, error_code: "unexpected_failure", msg: "Error sending confirmation email" })); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;   // queued; fails later, only in Auth's log
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  mode.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: new AuthClient({ url: `${mode.url}/auth/v1`, headers: { apikey: "anon-test" }, persistSession: false, autoRefreshToken: false }) }),
}));
// reportAuthError sends to Sentry only when Auth answered 5xx (or, on the server, did not answer): src/lib/report.ts
const reports = vi.hoisted(() => [] as { key: string; status?: number }[]);
vi.mock("@/lib/report", async (orig) => {
  const real = await orig<typeof import("@/lib/report")>();
  return { ...real, reportAuthError: vi.fn(async (key: string, error: { status?: number } | null) => {
    if (error && typeof error.status === "number" && error.status >= 500) reports.push({ key, status: error.status });
  }) };
});
const { default: LoginForm } = await import("./LoginForm");

async function requestCode() {
  render(<LoginForm />);
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "tester@example.test" } });
  fireEvent.click(screen.getByText("Send sign-in email"));
}
afterEach(() => { cleanup(); reports.length = 0; mode.otpCalls = 0; mode.mailFailures = 0; });

describe("sign-in email that could not be sent: what the page and our monitoring see", () => {
  it("background sending (staging, 24 Nov): the page says 'Email sent to …' and nothing reaches our monitoring", async () => {
    mode.value = "background";
    await requestCode();
    await waitFor(() => expect(screen.getByText("Email sent to tester@example.test")).toBeTruthy());
    expect(mode.mailFailures).toBe(1);                        // the mail failed…
    expect(screen.queryByRole("alert")).toBeNull();           // …the page cannot know
    expect(reports).toEqual([]);                              // …and neither can Sentry: only Auth's own log has it
  });

  it("sync sending (Auth's default): the page says the code couldn't be sent, and the failure is reported (authCodeSend, 500)", async () => {
    mode.value = "sync";
    await requestCode();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("We couldn't send the code just now. Try again in a minute."));
    await waitFor(() => expect(reports).toEqual([{ key: "authCodeSend", status: 500 }]));
  });
});
