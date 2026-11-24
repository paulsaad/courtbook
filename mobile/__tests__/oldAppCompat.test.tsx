/**
 * Review 23 Nov, finding 3: apps already installed (the staging app's Delete Account, released at ed68d21) must keep
 * working once 0086 is applied. This runs THAT released screen (an exact copy, fixtures/DeleteAccount.published.tsx)
 * against what the 0086 database really answers to its calls (fixtures/old_app_answers.json, recorded from the local
 * replica by supabase/tests/m86/old_app_answers.sh).
 */
jest.mock("../lib/supabase", () => ({ supabase: { rpc: jest.fn() } }));

import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import { DeleteAccount as Published } from "./fixtures/DeleteAccount.published";

declare const require: (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
const A = require("./fixtures/old_app_answers.json") as Record<string, unknown>;
const rpc = supabase.rpc as jest.Mock;
const ok = (data: unknown) => ({ data, error: null });
const err = (message: string) => ({ data: null, error: { message } });
let alert: jest.SpyInstance;
beforeEach(() => { rpc.mockReset(); alert = jest.spyOn(Alert, "alert").mockImplementation(() => {}); });
afterEach(() => alert.mockRestore());

describe("the released app's Delete Account, against 0086", () => {
  it("the database still answers every call it makes, with the fields it reads", () => {
    expect(A.request).toEqual({ status: "requested", requested_at: expect.any(String) });
    expect(A.mine_requested).toMatchObject({ status: "requested", requested_at: expect.any(String) });
    expect(A.cancel).toBe("ok");
    expect(A.mine_after_cancel).toBeNull();
    expect(A.booking_while_requested).toBe("account_closed");   // its text: "you can't make new bookings"
  });

  it("request: its confirmation, then 'You asked to delete…' with Keep my account — as it promises", async () => {
    let mine: unknown = A.mine_before;
    rpc.mockImplementation(async (fn: string, args?: unknown) => {
      if (fn === "my_account_deletion") return ok(mine);
      if (fn === "request_account_deletion") { expect(args).toEqual({ p_via: "app" }); mine = A.mine_requested; return ok(A.request); }
      if (fn === "cancel_account_deletion") { mine = A.mine_after_cancel; return ok(null); }
      throw new Error(fn);
    });
    await render(<Published />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    const [, , buttons] = alert.mock.calls[0];
    void buttons[1].onPress();
    expect(await screen.findByText(/You asked to delete your account on/)).toBeTruthy();
    // "Keep my account" cancels, and the card goes back to the start
    fireEvent.press(screen.getByTestId("delete-account-cancel"));
    expect(await screen.findByTestId("delete-account-request")).toBeTruthy();
    expect(screen.queryByText(/didn't work/)).toBeNull();
  });

  it("after 24 hours (processed): no Keep button, no error — the screen shows the request date", async () => {
    rpc.mockImplementation(async (fn: string) => (fn === "my_account_deletion" ? ok(A.mine_promoted) : ok(null)));
    await render(<Published />);
    expect(await screen.findByText(/You asked to delete your account on/)).toBeTruthy();
    expect(screen.queryByTestId("delete-account-cancel")).toBeNull();   // it only offers Keep for "requested"
  });

  it("asking again after processing: the closed record back, no error shown", async () => {
    let mine: unknown = null;
    rpc.mockImplementation(async (fn: string) => {
      if (fn === "my_account_deletion") return ok(mine);
      if (fn === "request_account_deletion") { mine = A.mine_promoted; return ok(A.request_after_promotion); }
      throw new Error(fn);
    });
    await render(<Published />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    void alert.mock.calls[0][2][1].onPress();
    expect(await screen.findByText(/You asked to delete your account on/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("control: WITHOUT the compatibility (the call refused, as the first 0086 draft did), the released screen breaks", async () => {
    rpc.mockImplementation(async (fn: string) => (fn === "my_account_deletion" ? ok(null) : err("permission denied for function request_account_deletion")));
    await render(<Published />);
    fireEvent.press(await screen.findByTestId("delete-account-request"));
    await act(async () => { await alert.mock.calls[0][2][1].onPress(); });
    await waitFor(() => expect(screen.getByText("That didn't work. Please try again.")).toBeTruthy());
  });
});
