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

it("shows the sport on the ticket band when given", async () => {
  await render(
    <Ticket date="Saturday 14 November" start="18:30" sport={{ key: "padel", label: "Padel" }}>
      <TicketRow label="Club" value="Sample Club" last />
    </Ticket>
  );
  expect(screen.getByText("SATURDAY 14 NOVEMBER")).toBeTruthy();
  expect(screen.getByText("Padel")).toBeTruthy();
});

it("lays the times out in a column of their own: no wrapping row, no baseline alignment (iPhone, 2026-11-14)", async () => {
  const { StyleSheet } = require("react-native");
  await render(
    <Ticket date="Saturday 14 November" start="21:30" end="23:00">
      <TicketRow label="Club" value="Sample Club" last />
    </Ticket>
  );
  const times = StyleSheet.flatten(screen.getByTestId("ticket-times").props.style);
  expect(times.flexDirection ?? "column").toBe("column");
  expect(times.flexWrap).toBeUndefined();
  expect(times.alignItems).not.toBe("baseline");
  expect(screen.getByText("to 23:00")).toBeTruthy();
  const mark = StyleSheet.flatten(screen.getByTestId("ticket-mark", { includeHiddenElements: true }).props.style);
  expect(mark.position).not.toBe("absolute");
  expect(mark.flexShrink).toBe(0);
});
