// @vitest-environment jsdom
// H10: the board sends Beirut calendar-day ends for Today and This week (src/lib/playWindow.ts), nothing for Any day
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Record<string, unknown>[] = [];
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (_fn: string, a: Record<string, unknown>) => { calls.push(a); return { data: [], error: null }; } }),
}));
import PlayBoard from "./PlayBoard";

afterEach(() => { cleanup(); vi.useRealTimers(); calls.length = 0; });

describe("Find a game window sent to open_matches", () => {
  it("Thu 14:19 Beirut: Today → Beirut midnight; This week → end of Wed 2 Dec; Any day → none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T12:19:00Z"));
    render(<PlayBoard areas={[]} sports={[]} initial={[]} clubs={[]} />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.at(-1)!.p_to).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(calls.at(-1)!.p_to).toBe("2026-11-26T22:00:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(calls.at(-1)!.p_to).toBe("2026-12-02T22:00:00.000Z"));
  });
});
