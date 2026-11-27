// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a> }));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
type Call = { fn: string; args: Record<string, unknown> };
let calls: Call[] = [];
let answer: (c: Call) => { data: unknown; error: unknown } = () => ({ data: null, error: null });
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { const c = { fn, args }; calls.push(c); return answer(c); } }),
}));

import ReportsBoard, { type Report } from "./ReportsBoard";

const report = (over: Partial<Report> = {}): Report => ({
  id: "r1", created_at: "2026-11-20T10:00:00Z", target_kind: "message", reason: "abuse", note: "rude", snapshot: "the reported text",
  status: "open", reporter_id: "p1", reporter_name: "Rana", profile_id: "p2", reported_name: "Sami", reported_suspended: false,
  reports_against: 2, match_id: "m1", message_id: "msg1", message_deleted: false, handled_at: null, action: null, ...over,
});

beforeEach(() => { calls = []; refresh.mockReset(); answer = () => ({ data: null, error: null }); });
afterEach(cleanup);

describe("Reports (admin)", () => {
  it("shows the report and its evidence", async () => {
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    expect(screen.getByText("Message · Abuse or harassment")).toBeTruthy();
    expect(screen.getByText("the reported text")).toBeTruthy();
    expect(screen.getByText(/2 reports in total/)).toBeTruthy();
  });

  it("shows how many players blocked the reported player (0075), and nothing when none or unknown", () => {
    const { rerender } = render(<ReportsBoard status="open" reports={[report()]} blocksReceived={{ p2: 3 }} unavailable={false} failed={false} />);
    expect(screen.getByText(/blocked by 3 players/)).toBeTruthy();
    rerender(<ReportsBoard status="open" reports={[report()]} blocksReceived={{ p2: 0 }} unavailable={false} failed={false} />);
    expect(screen.queryByText(/blocked by/)).toBeNull();
    rerender(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    expect(screen.queryByText(/blocked by/)).toBeNull();
  });

  it("marks a report handled, with what was done", async () => {
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    fireEvent.change(screen.getByLabelText("What was done (optional)"), { target: { value: "warned" } });
    fireEvent.click(screen.getByText("Mark handled"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ fn: "admin_resolve_report", args: { p_report: "r1", p_status: "actioned", p_action: "warned" } }]);
  });

  it("dismisses a report", async () => {
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    fireEvent.click(screen.getByText("Dismiss"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls[0]).toEqual({ fn: "admin_resolve_report", args: { p_report: "r1", p_status: "dismissed", p_action: "" } });
  });

  it("suspends only with a reason", async () => {
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    fireEvent.click(screen.getByText("Suspend account"));
    const go = screen.getByText("Suspend Sami") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why suspend Sami/), { target: { value: "  threats  " } });
    fireEvent.click(go);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ fn: "admin_suspend", args: { p_profile: "p2", p_reason: "threats" } }]);
  });

  it("removes the reported player's photo only with a reason, without suspending (draft #67)", async () => {
    answer = () => ({ data: true, error: null });
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} photos />);
    fireEvent.click(screen.getByText("Remove photo"));
    const go = screen.getAllByText("Remove photo").find((b) => b.className.includes("bg-action")) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why remove Sami's photo/), { target: { value: " nudity " } });
    fireEvent.click(go);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ fn: "admin_remove_player_photo", args: { p_profile: "p2", p_reason: "nudity" } }]);
    expect(screen.getByRole("status").textContent).toBe("Sami's photo was removed.");
  });
  it("no photo to remove: says so, nothing refreshed", async () => {
    answer = () => ({ data: false, error: null });
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} photos />);
    fireEvent.click(screen.getByText("Remove photo"));
    fireEvent.change(screen.getByLabelText(/Why remove Sami's photo/), { target: { value: "x" } });
    fireEvent.click(screen.getAllByText("Remove photo").find((b) => b.className.includes("bg-action"))!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Sami has no photo to remove."));
    expect(refresh).not.toHaveBeenCalled();
  });
  it("not offered on a report without a player, nor where the photo schema is missing", () => {
    render(<ReportsBoard status="open" reports={[report({ profile_id: null })]} unavailable={false} failed={false} photos />);
    expect(screen.queryByText("Remove photo")).toBeNull();
    cleanup();
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    expect(screen.queryByText("Remove photo")).toBeNull();
  });

  it("lifts a suspension", async () => {
    render(<ReportsBoard status="open" reports={[report({ reported_suspended: true })]} unavailable={false} failed={false} />);
    expect(screen.queryByText("Suspend account")).toBeNull();
    fireEvent.click(screen.getByText("Lift suspension"));
    await waitFor(() => expect(calls[0]).toEqual({ fn: "admin_unsuspend", args: { p_profile: "p2" } }));
  });

  it("hides the message; not offered once it is deleted", async () => {
    const { rerender } = render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    fireEvent.click(screen.getByText("Hide message"));
    await waitFor(() => expect(calls[0]).toEqual({ fn: "admin_hide_message", args: { p_message: "msg1" } }));
    rerender(<ReportsBoard status="open" reports={[report({ message_deleted: true })]} unavailable={false} failed={false} />);
    expect(screen.queryByText("Hide message")).toBeNull();
    expect(screen.getByText(/since deleted/)).toBeTruthy();
  });

  it("loads the conversation on demand, the reported message marked", async () => {
    answer = (c) => c.fn === "admin_report_messages"
      ? { data: [{ id: "msg1", created_at: "2026-11-20T10:00:00Z", sender: "Sami", body: "the reported text", deleted: false, reported: true }], error: null }
      : { data: null, error: null };
    render(<ReportsBoard status="open" reports={[report({ snapshot: null })]} unavailable={false} failed={false} />);
    fireEvent.click(screen.getByText("Show conversation"));
    const list = await screen.findByLabelText("Conversation around the report");
    expect(list.textContent).toContain("the reported text");
    expect(calls).toEqual([{ fn: "admin_report_messages", args: { p_report: "r1" } }]);
  });

  it("a refusal from the server is shown as a sentence (not an admin)", async () => {
    answer = () => ({ data: null, error: { message: "forbidden" } });
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} />);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(await screen.findByText("You are not allowed to do that.")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("closed reports offer no decision", () => {
    render(<ReportsBoard status="actioned" reports={[report({ status: "actioned", handled_at: "2026-11-20T11:00:00Z", action: "warned" })]} unavailable={false} failed={false} />);
    expect(screen.queryByText("Mark handled")).toBeNull();
    expect(screen.queryByText("Hide message")).toBeNull();
    expect(screen.getByText(/Handled .* · warned/)).toBeTruthy();
  });

  it("app problems and suggestions are listed apart, with their text and app version, and can be closed", async () => {
    render(<ReportsBoard status="open" unavailable={false} failed={false} reports={[
      report(),
      report({ id: "f1", target_kind: "feedback", reason: "app_problem", note: "Map stays blank", snapshot: "android · 0.3.0", profile_id: null, reported_name: null, match_id: null, message_id: null, reports_against: 0 }),
    ]} />);
    const feedback = screen.getByRole("region", { name: "App problems and suggestions" });
    expect(feedback.textContent).toContain("Help & Feedback · App problem");
    expect(feedback.textContent).toContain("Map stays blank");
    expect(feedback.textContent).toContain("Sent from android · 0.3.0");
    expect(feedback.textContent).not.toContain("Suspend account");
    expect(feedback.textContent).not.toContain("Show conversation");
    expect(screen.getByRole("region", { name: "Player reports" }).textContent).toContain("the reported text");
  });

  it("says so before migration 0074", () => {
    render(<ReportsBoard status="open" reports={[]} unavailable failed={false} />);
    expect(screen.getByText(/not available on this database yet/)).toBeTruthy();
  });
});

describe("Reports (admin), 0082 moderation readiness", () => {
  const st = (over = {}) => ({ r1: { report_id: "r1", legal_hold: false, handled_by_name: "Paul", closed_at: null, log_entries: 2, ...over } });
  it("lifting a suspension asks for a reason and sends it", async () => {
    render(<ReportsBoard status="open" reports={[report({ reported_suspended: true })]} unavailable={false} failed={false} state={st()} />);
    fireEvent.click(screen.getByRole("button", { name: "Lift suspension" }));
    const send = screen.getAllByRole("button", { name: "Lift suspension" }).at(-1)!;
    expect(send.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(/Why lift the suspension/), { target: { value: "apologised" } });
    fireEvent.click(send);
    await waitFor(() => expect(calls).toContainEqual({ fn: "admin_unsuspend", args: { p_profile: "p2", p_reason: "apologised" } }));
  });
  it("a handled report shows who handled it and can be reopened with a reason", async () => {
    render(<ReportsBoard status="actioned" reports={[report({ status: "actioned", handled_at: "2026-11-21T10:00:00Z", action: "warned" })]} unavailable={false} failed={false} state={st()} />);
    expect(screen.getByText(/by Paul/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    fireEvent.change(screen.getByLabelText(/Why reopen it/), { target: { value: "new evidence" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Reopen" }).at(-1)!);
    await waitFor(() => expect(calls).toContainEqual({ fn: "admin_reopen_report", args: { p_report: "r1", p_note: "new evidence" } }));
  });
  it("legal hold: badge when on; the control sends the opposite value with a reason", async () => {
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} state={st({ legal_hold: true })} />);
    expect(screen.getByText("legal hold")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release legal hold" }));
    fireEvent.change(screen.getByLabelText(/Why release the hold/), { target: { value: "case closed" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Release legal hold" }).at(-1)!);
    await waitFor(() => expect(calls).toContainEqual({ fn: "admin_set_legal_hold", args: { p_report: "r1", p_hold: false, p_note: "case closed" } }));
  });
  it("history lists the logged actions", async () => {
    answer = (c) => c.fn === "admin_moderation_log" ? { data: [{ at: "2026-11-21T10:00:00Z", admin_name: "Paul", action: "suspend", note: "abuse", report_id: null }], error: null } : { data: null, error: null };
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} state={st()} />);
    fireEvent.click(screen.getByRole("button", { name: "History (2)" }));
    await waitFor(() => expect(screen.getByText(/Suspended/)).toBeTruthy());
    expect(screen.getByText(/— abuse/)).toBeTruthy();
  });
  it("before 0082 (no state) the new controls are not shown", () => {
    render(<ReportsBoard status="actioned" reports={[report({ status: "actioned" })]} unavailable={false} failed={false} />);
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /legal hold/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Clear text/ })).toBeNull();
  });
  it("the 180-day clearing button reports how many were cleared", async () => {
    answer = (c) => c.fn === "clear_old_report_text" ? { data: 3, error: null } : { data: null, error: null };
    render(<ReportsBoard status="open" reports={[report()]} unavailable={false} failed={false} state={st()} />);
    fireEvent.click(screen.getByRole("button", { name: /Clear text of reports closed over 180 days ago/ }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Cleared 3 report text/));
    expect(calls).toContainEqual({ fn: "clear_old_report_text", args: { p_days: 180 } });
  });
});
