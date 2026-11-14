import { fireEvent, render, screen } from "@testing-library/react-native";
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(async () => {}), notificationAsync: jest.fn(async () => {}), NotificationFeedbackType: { Success: "success" } }));
import { TimeTile, tileLabel, tileState } from "../components/TimeTile";

describe("tile states", () => {
  it.each([
    [0, false, "booked"], [0, true, "booked"], [1, false, "limited"], [3, false, "free"], [1, true, "selected"], [3, true, "selected"],
  ])("%i free courts, selected=%s -> %s", (n, sel, state) => {
    expect(tileState(n as number, sel as boolean)).toBe(state);
  });

  it("puts the state in words, never colour alone, and never promises the last court", () => {
    expect(tileLabel("free", "$30", 3)).toBe("$30 · 3 courts");
    expect(tileLabel("limited", "$30", 1)).toBe("$30 · 1 court free");
    expect(tileLabel("selected", "$30", 2)).toBe("$30 · selected");
    expect(tileLabel("booked", "$30", 0)).toBe("Not free");
    expect(tileLabel("free", null, 3)).toBe("3 courts");
    expect(tileLabel("limited", "$30", 1)).not.toMatch(/last|guaranteed|yours/i);
  });
});

describe("TimeTile", () => {
  it("announces time, price, courts and selection to screen readers", async () => {
    await render(<TimeTile time="18:30" price="$30" freeCourts={2} selected onPress={() => {}} />);
    const b = screen.getByRole("button", { name: "18:30, $30, 2 courts free, selected" });
    expect(b.props.accessibilityState).toMatchObject({ selected: true, disabled: false });
  });

  it("cannot be chosen when booked", async () => {
    const onPress = jest.fn();
    await render(<TimeTile time="19:00" price="$30" freeCourts={0} selected={false} onPress={onPress} />);
    await fireEvent.press(screen.getByRole("button", { name: "19:00, not free" }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("chooses a free time", async () => {
    const onPress = jest.fn();
    await render(<TimeTile time="17:00" price="$30" freeCourts={1} selected={false} onPress={onPress} />);
    await fireEvent.press(screen.getByRole("button", { name: "17:00, $30, 1 court free" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
