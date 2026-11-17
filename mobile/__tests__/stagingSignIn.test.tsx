jest.mock("../lib/supabase", () => ({ supabase: { auth: { signInWithPassword: jest.fn() } } }));
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { supabase } from "../lib/supabase";
import { STAGING_SIGN_IN_RETRY, StagingPasswordSignIn } from "../components/StagingPasswordSignIn";

const signIn = supabase.auth.signInWithPassword as jest.Mock;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

beforeEach(() => signIn.mockReset());

async function attempt(password: string) {
  await fireEvent.changeText(screen.getByTestId("staging-password"), password);
  await fireEvent.press(screen.getByTestId("staging-sign-in"));
  await flush();
}

it("after a failed attempt the password field is empty and the next attempt sends only the new password", async () => {
  signIn.mockResolvedValueOnce({ error: { message: "Invalid login credentials" } }).mockResolvedValueOnce({ error: null });
  const onDone = jest.fn();
  await render(<StagingPasswordSignIn onDone={onDone} />);
  await fireEvent.changeText(screen.getByTestId("staging-email"), " paul.tester@courtbook.test ");

  await attempt("old-password-1");
  expect(screen.getByTestId("staging-password").props.value).toBe("");
  expect(screen.getByText(`Test sign-in failed: Invalid login credentials\n${STAGING_SIGN_IN_RETRY}`)).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();

  // what a paste does on Android: the field's text plus the pasted text; the field is now empty
  const field = screen.getByTestId("staging-password");
  await attempt(field.props.value + "Correct-Password-20c");
  expect(signIn).toHaveBeenNthCalledWith(2, { email: "paul.tester@courtbook.test", password: "Correct-Password-20c" });
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("a successful first attempt is unchanged", async () => {
  signIn.mockResolvedValueOnce({ error: null });
  const onDone = jest.fn();
  await render(<StagingPasswordSignIn onDone={onDone} />);
  await fireEvent.changeText(screen.getByTestId("staging-email"), "paul.tester@courtbook.test");
  await attempt("Correct-Password-20c");
  expect(signIn).toHaveBeenCalledWith({ email: "paul.tester@courtbook.test", password: "Correct-Password-20c" });
  expect(onDone).toHaveBeenCalledTimes(1);
});

it("autofill is off for both fields, so nothing can be filled in unseen", async () => {
  await render(<StagingPasswordSignIn onDone={() => {}} />);
  for (const id of ["staging-email", "staging-password"]) {
    const p = screen.getByTestId(id).props;
    expect([p.importantForAutofill, p.autoComplete]).toEqual(["no", "off"]);
  }
});
