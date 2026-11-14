import { render, screen } from "@testing-library/react-native";
import { PlayerSlots } from "../components/PlayerSlots";
import { Brand } from "../components/Brand";

it("says how many spots are left in words, not only with red circles", async () => {
  await render(<PlayerSlots players={["NH", "RS"]} capacity={4} />);
  expect(screen.getByText("2 spots left")).toBeTruthy();
  expect(screen.getByLabelText("2 of 4 players, 2 spots left")).toBeTruthy();
});

it("says Full, in the neutral colour, when no place is open", async () => {
  await render(<PlayerSlots players={["A", "B", "C", "D"]} capacity={4} />);
  expect(screen.getByText("Full")).toBeTruthy();
});

it("names the brand for screen readers", async () => {
  await render(<Brand />);
  expect(screen.getByLabelText("CourtBook")).toBeTruthy();
});
