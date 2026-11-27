/**
 * F2 review S2 (26 Nov): the age screen's "Sign out" is an ordinary sign-out, so it ends this phone's session only
 * (scope local), like Profile. It used the auth-js default (global), which signed the person out on every device.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";

const mockSignOut = jest.fn(async (_o?: unknown) => ({ error: null }));
jest.mock("../lib/supabase", () => ({ supabase: { auth: { signOut: (o?: unknown) => mockSignOut(o) } } }));
jest.mock("../lib/session", () => ({ useSession: () => ({ status: "signed-in", session: { user: { id: "me" } } }) }));
jest.mock("../lib/age", () => ({ useAgeState: () => "needed", useConfirmAge: () => async () => null }));

import { AgeGate } from "../components/AgeGate";

it("'No, I am under 18' → Sign out: this phone only (scope local), never the default (global)", async () => {
  await render(<AgeGate />);
  await fireEvent.press(screen.getByTestId("age-no"));
  await fireEvent.press(screen.getByTestId("age-signout"));
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
});
