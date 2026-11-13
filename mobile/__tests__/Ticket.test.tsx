import { render, screen } from "@testing-library/react-native";
import { Ticket, TicketRow } from "../components/Ticket";
import { SportMark, SPORTS } from "../components/SportMark";

it("shows the booking's own payment and cancellation wording", async () => {
  await render(
    <Ticket date="Saturday 14 November" start="18:30" end="20:00">
      <TicketRow label="Payment" value="$30 at the club" note="Nothing was charged in the app" />
      <TicketRow label="Cancellation" value="Free until Sat 12:30" last />
    </Ticket>
  );
  expect(screen.getByText("18:30")).toBeTruthy();
  expect(screen.getByText("$30 at the club")).toBeTruthy();
  expect(screen.getByText("Nothing was charged in the app")).toBeTruthy();
  expect(screen.getByLabelText("Saturday 14 November, 18:30 to 20:00")).toBeTruthy();
});

it("draws a mark for every sport, and for a sport it does not know", async () => {
  for (const s of [...SPORTS, "curling"]) await render(<SportMark sport={s} />);
});
