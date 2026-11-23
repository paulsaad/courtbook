// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { CONFIRM_TEXT, CLOSED_TEXT, CLOSED_TITLE } from "@/lib/deletion/copy";

let state: unknown = null;
let stateError: unknown = null;
const signOut = vi.fn(async () => ({ error: null }));
const rpc = vi.fn(async (fn: string) => (fn === "my_account_deletion" ? { data: state, error: stateError } : { data: null, error: null }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc, auth: { signOut } }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
const DeleteAccount = (await import("./DeleteAccount")).default;
const AccountClosed = (await import("../account-closed/page")).default;

const assign = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state = null; stateError = null; signOut.mockClear(); rpc.mockClear(); assign.mockClear();
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ closed: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openConfirm() {
  render(<DeleteAccount />);
  fireEvent.click(await screen.findByText("Delete my account…"));
}

describe("website Delete my account (0086)", () => {
  it("one confirmation with the D5 text, two choices, no 'cancel later' promise", async () => {
    await openConfirm();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("Delete your CourtBook account?")).toBeTruthy();
    expect(screen.getByText(CONFIRM_TEXT)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete my account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my account" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cancel the request|can cancel|until we process/i);
  });
  it("Keep my account goes back and calls nothing", async () => {
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));
    expect(screen.getByText("Delete my account…")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("confirming: one POST to the close route with only {confirm:true}; then local sign-out and the closed page", async () => {
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account-closed"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/account/close");
    expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["my_account_deletion"]);   // never calls a deletion RPC itself
  });
  it("the button is disabled while working (no double submit)", async () => {
    let finish: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { finish = r; }));
    await openConfirm();
    const b = screen.getByRole("button", { name: "Delete my account" });
    fireEvent.click(b);
    await waitFor(() => expect((screen.getByRole("button", { name: "Closing your account…" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Closing your account…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ closed: true }), { status: 200 }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
  });
  it("staff: the refusal is shown, nothing else happens", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "staff_role" }), { status: 409 }));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/staff at a club.*Contact CourtBook support/);
    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it("a server error after the close committed: the account is closed, so it still signs out and leaves", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    await openConfirm();
    state = { status: "closing", requested_at: "2026-11-23T00:00:00Z", closed: true };
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account-closed"));
  });
  it("a network failure with nothing closed: says nothing changed, stays", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await openConfirm();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/nothing was changed/);
    expect(assign).not.toHaveBeenCalled();
  });
  it("still signed in to an already-closed account: signs out and goes to the closed page, shows no button", async () => {
    state = { status: "closed", requested_at: "2026-11-23T00:00:00Z", closed: true };
    render(<DeleteAccount />);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/account-closed"));
    expect(screen.queryByText("Delete my account…")).toBeNull();
  });
  it("before 0086 (the function is missing): shows nothing", async () => {
    stateError = { message: "Could not find the function", code: "PGRST202" };
    const { container } = render(<DeleteAccount />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("the closed page (D5)", () => {
  it("says closed and processing; never that the data is deleted", () => {
    const { container } = render(<AccountClosed />);
    expect(container.textContent).toContain(CLOSED_TITLE);
    expect(container.textContent).toContain(CLOSED_TEXT);
    expect(container.textContent).not.toMatch(/has been deleted|have been deleted|is deleted|was deleted|permanently deleted|erased/i);
  });
  it("no screen claims erasure is complete", () => {
    for (const f of ["src/lib/deletion/copy.ts", "src/app/profile/DeleteAccount.tsx", "src/app/account-closed/page.tsx", "mobile/components/DeleteAccount.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/(data|account) (has|have) been deleted|was deleted|is now deleted|erased/i);
    }
  });
});
