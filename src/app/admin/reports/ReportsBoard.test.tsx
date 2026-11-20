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

  it("says so before migration 0074", () => {
    render(<ReportsBoard status="open" reports={[]} unavailable failed={false} />);
    expect(screen.getByText(/not available on this database yet/)).toBeTruthy();
  });
});
