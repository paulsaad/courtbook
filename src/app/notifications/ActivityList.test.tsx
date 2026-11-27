// @vitest-environment jsdom
/**
 * Activity, local pilot build at 360 px (26 Nov): after deleting one item, deleting another with no connection
 * brought back the first one (the list was reset to what the page first loaded) and said nothing; "Clear all"
 * with no connection also said nothing. Unread items were marked by a green dot only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
let answers: { data: unknown; error: unknown }[] = [];
const calls: { fn: string; args: unknown }[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return answers.shift() ?? { data: null, error: null }; } }),
}));
import ActivityList, { type Note } from "./ActivityList";

const note = (id: string, body: string, read = false): Note => ({ id, kind: "match_message", match_id: "m1", body, created_at: "2026-11-26T10:00:00Z", read_at: read ? "2026-11-26T10:01:00Z" : null });
const initial = [note("a", "First"), note("b", "Second"), note("c", "Third", true)];
const shown = () => screen.queryAllByRole("listitem").map((li) => li.querySelector("a .text-sm")?.textContent).filter(Boolean);
const del = (body: string) => fireEvent.click(within(screen.getByText(body).closest("li")!).getByRole("button", { name: "Delete this item" }));
const OFFLINE = "Couldn't reach CourtBook. Check your connection and try again.";

beforeEach(() => { answers = []; calls.length = 0; });
afterEach(cleanup);

describe("Activity", () => {
  it("a failed delete puts back only that item, where it was, and says why", async () => {
    render(<ActivityList initial={initial} />);
    del("First");
    await waitFor(() => expect(calls).toHaveLength(1));
    answers = [{ data: null, error: { message: "TypeError: Failed to fetch" } }];
    del("Third");
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(shown()).toEqual(["Second", "Third"]);   // "First" stays deleted
  });

  it("a refused delete says so in plain words", async () => {
    answers = [{ data: null, error: { message: "permission denied" } }];
    render(<ActivityList initial={initial} />);
    del("Second");
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't delete it. Try again.");
    expect(shown()).toEqual(["First", "Second", "Third"]);
  });

  it("Clear all with no connection keeps the list and says why", async () => {
    answers = [{ data: null, error: { message: "Load failed" } }];
    render(<ActivityList initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear all" })[0]);
    expect((await screen.findByRole("alert")).textContent).toBe(OFFLINE);
    expect(shown()).toEqual(["First", "Second", "Third"]);
  });

  it("Clear all works", async () => {
    render(<ActivityList initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear all" })[0]);
    await waitFor(() => expect(shown()).toEqual([]));
    expect(screen.getByText(/Nothing here/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("unread items say so to screen readers", () => {
    render(<ActivityList initial={initial} />);
    const links = screen.getAllByRole("link").filter((a) => a.getAttribute("href") === "/matches/m1");
    expect(links.map((a) => a.textContent?.startsWith("New: "))).toEqual([true, true, false]);
  });
});
