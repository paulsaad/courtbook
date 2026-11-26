// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

let calls: { fn: string; args: unknown }[] = [];
let answers: { data: unknown; error: unknown }[] = [];
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return answers.shift() ?? { data: null, error: null }; } }),
}));
let user: { id: string } | null = { id: "me" };
let serverRead: { data: unknown; error: unknown } = { data: [], error: null };
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: async (fn: string) => { calls.push({ fn, args: undefined }); return serverRead; },
  }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect:${to}`); } }));

import BlockedList from "./BlockedList";
import BlockedPlayersPage from "./page";

beforeEach(() => { calls = []; answers = []; user = { id: "me" }; serverRead = { data: [], error: null }; });
afterEach(cleanup);

describe("Blocked players page", () => {
  it("signed out → sign in, then back here", async () => {
    user = null;
    await expect(BlockedPlayersPage()).rejects.toThrow("redirect:/login?next=/profile/blocked");
    expect(calls).toEqual([]);
  });

  it("a failed read is an error, never 'You haven't blocked anyone'", async () => {
    serverRead = { data: null, error: { message: "permission denied for function my_blocked_players", code: "42501" } };
    await expect(BlockedPlayersPage()).rejects.toThrow("Couldn't load your blocked players");
  });

  it("shows only names: no contact details even if the server sent them", async () => {
    serverRead = { data: [{ profile_id: "sami", name: "Sami", created_at: "2026-11-20", phone: "+96170123456", email: "sami@example.com" }], error: null };
    const { container } = render(await BlockedPlayersPage());
    expect(screen.getByText("Sami")).toBeTruthy();
    expect(container.textContent).not.toMatch(/96170123456|sami@example\.com/);
    expect(calls).toEqual([{ fn: "my_blocked_players", args: undefined }]);
  });

  it("empty list says so", () => {
    render(<BlockedList initial={[]} />);
    expect(screen.getByText("You haven't blocked anyone.")).toBeTruthy();
  });

  it("unblock asks first, then removes the row", async () => {
    render(<BlockedList initial={[{ profile_id: "sami", name: "Sami" }, { profile_id: "karim", name: "Karim" }]} />);
    fireEvent.click(screen.getAllByText("Unblock")[0]);
    const ask = screen.getByRole("alertdialog", { name: "Unblock Sami?" });
    expect(ask.textContent).toContain("They aren't told.");
    expect(calls).toEqual([]);
    fireEvent.click(within(ask).getByText("Unblock"));
    expect(await screen.findByText("You unblocked Sami.")).toBeTruthy();
    expect(calls).toEqual([{ fn: "unblock_player", args: { p_profile: "sami" } }]);
    expect(screen.queryByText("Sami")).toBeNull();
    expect(screen.getByText("Karim")).toBeTruthy();
  });

  it("a failed unblock keeps the row and says why", async () => {
    answers = [{ data: null, error: { message: "Failed to fetch" } }];
    render(<BlockedList initial={[{ profile_id: "sami", name: "Sami" }]} />);
    fireEvent.click(screen.getByText("Unblock"));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByText("Unblock"));
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't reach CourtBook. Check your connection and try again.");
    expect(screen.getAllByText("Sami").length).toBe(1);
    expect(screen.queryByText("You unblocked Sami.")).toBeNull();
  });
});
