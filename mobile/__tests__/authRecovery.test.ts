jest.mock("../lib/supabase", () => ({ supabase: { auth: { signOut: jest.fn(async () => ({ error: null })) } } }));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
import { router } from "expo-router";
import { supabase } from "../lib/supabase";
import { recoverFromAuthFailure, trackPath } from "../lib/authRecovery";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it("signs out on this phone only and reopens sign-in over the screen the person was on", async () => {
  trackPath("/club/batroun");
  trackPath("/sign-in"); // never remembered as the place to return to
  await Promise.all([recoverFromAuthFailure(), recoverFromAuthFailure(), recoverFromAuthFailure()]);
  expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(router.push).toHaveBeenCalledTimes(1);
  expect(router.push).toHaveBeenCalledWith({ pathname: "/sign-in", params: { returnTo: "/club/batroun", reason: "expired" } });
});
