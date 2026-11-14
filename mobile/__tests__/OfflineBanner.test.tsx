import { act, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { onlineManager } from "@tanstack/react-query";
import { OfflineBanner } from "../components/OfflineBanner";

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

it("renders nothing while online and appears when the connection drops", async () => {
  onlineManager.setOnline(true);
  await render(<SafeAreaProvider initialMetrics={metrics}><OfflineBanner /></SafeAreaProvider>);
  expect(screen.queryByText(/offline/)).toBeNull();
  await act(async () => onlineManager.setOnline(false));
  expect(screen.getByText(/You're offline/)).toBeTruthy();
  await act(async () => onlineManager.setOnline(true));
  expect(screen.queryByText(/offline/)).toBeNull();
});
