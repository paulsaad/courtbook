import { act, render, screen } from "@testing-library/react-native";
import { onlineManager } from "@tanstack/react-query";
import { Freshness } from "../components/Freshness";

afterEach(() => onlineManager.setOnline(true));

it("switches between 'Checked …' and the offline wording as the connection changes", async () => {
  onlineManager.setOnline(true);
  await render(<Freshness lastSuccessAt={Date.now() - 2 * 60_000} fetching={false} failedSinceSuccess={false} />);
  expect(screen.getByText(/^Checked 2 min ago$/)).toBeTruthy();
  await act(async () => onlineManager.setOnline(false));
  expect(screen.getByText(/^Offline · times as of \d\d:\d\d$/)).toBeTruthy();
  expect(screen.queryByText(/Checked/)).toBeNull();
  await act(async () => onlineManager.setOnline(true));
  expect(screen.getByText(/^Checked 2 min ago$/)).toBeTruthy();
});
