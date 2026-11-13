import { fireEvent, render, screen } from "@testing-library/react-native";
import { Button } from "../components/Button";

describe("Button", () => {
  it("fires once per press when idle", async () => {
    const onPress = jest.fn();
    await render(<Button label="Reserve" onPress={onPress} />);
    await fireEvent.press(screen.getByRole("button", { name: "Reserve" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while busy and tells screen readers it is busy", async () => {
    const onPress = jest.fn();
    await render(<Button label="Reserve" busy onPress={onPress} />);
    const b = screen.getByRole("button", { name: "Reserve" });
    await fireEvent.press(b);
    await fireEvent.press(b);
    expect(onPress).not.toHaveBeenCalled();
    expect(b.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  });
});
