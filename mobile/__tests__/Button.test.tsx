import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { Button } from "../components/Button";
import { color } from "../lib/theme";

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

  it("disabled: cannot be pressed, and its words stay readable (O3: >= 4.5:1, no fade)", async () => {
    const onPress = jest.fn();
    await render(<Button label="Connect to the internet to reserve" disabled onPress={onPress} />);
    const b = screen.getByRole("button", { name: "Connect to the internet to reserve" });
    await fireEvent.press(b);
    expect(onPress).not.toHaveBeenCalled();
    expect(b.props.accessibilityState).toMatchObject({ disabled: true });
    const box = StyleSheet.flatten(b.props.style);
    const text = StyleSheet.flatten(screen.getByText("Connect to the internet to reserve").props.style);
    expect(box.opacity ?? 1).toBe(1);
    expect(contrast(text.color, box.backgroundColor)).toBeGreaterThanOrEqual(4.5);
  });
});

function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
void color;
