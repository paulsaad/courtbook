// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import DeletionsBoard from "./DeletionsBoard";

afterEach(cleanup);
const board = (worker: { last_run_at: string | null; active: boolean } | null, unavailable = false) =>
  render(<DeletionsBoard rows={[]} progress={[]} unavailable={unavailable} failed={false} selfId="me" worker={worker} />);

describe("admin deletions: retry worker heartbeat (review 23 Nov, finding 1)", () => {
  it("recent run: shows when, no warning", () => {
    board({ last_run_at: "2026-11-23T10:07:00Z", active: true });
    expect(screen.getByRole("status").textContent).toMatch(/last run 23 Nov 12:07/);
    expect(screen.queryByText(/paused/)).toBeNull();
  });
  it("stale run: warns that app deletion is paused", () => {
    board({ last_run_at: "2026-11-23T06:00:00Z", active: false });
    expect(screen.getByRole("status").textContent).toMatch(/over an hour ago[\s\S]*app is paused/);
  });
  it("never run: says so", () => {
    board({ last_run_at: null, active: false });
    expect(screen.getByRole("status").textContent).toMatch(/never run/);
  });
  it("before 0086 or on error: nothing about the worker", () => {
    board(null);
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    board({ last_run_at: null, active: false }, true);
    expect(screen.queryByText(/never run/)).toBeNull();
  });
});
