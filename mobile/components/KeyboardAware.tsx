import { useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, View, type ViewStyle } from "react-native";

/**
 * Keeps its bottom (a composer, a Save button) above the on-screen keyboard on both platforms.
 * The app draws edge to edge, so on Android the window is not resized when the keyboard opens
 * (the chat composer was hidden behind it on the emulator, 20 Nov); padding is added instead. The
 * offset is where this view starts on screen (under the header), measured, not guessed.
 */
export function KeyboardAware({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const ref = useRef<{ measureInWindow: (cb: (x: number, y: number) => void) => void } | null>(null);
  const [top, setTop] = useState(0);
  return (
    <View ref={ref as never} style={[{ flex: 1 }, style]} onLayout={() => ref.current?.measureInWindow((_x, y) => { if (Math.abs(y - top) > 1) setTop(y); })}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={top}>
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}
