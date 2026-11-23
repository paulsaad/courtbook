import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, View, type ScrollViewInstance, type ViewStyle } from "react-native";

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

/** True while the on-screen keyboard is open (Android reports "did" events only; iOS "will", for no lag). */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const a = Keyboard.addListener(show, () => setVisible(true));
    const b = Keyboard.addListener(hide, () => setVisible(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return visible;
}

/**
 * A ScrollView ref that scrolls to its end each time the keyboard opens, so a form's text field and its Send button
 * come into view above the keyboard (used by the report and feedback sheets).
 */
export function useRevealOnKeyboard(keyboard: boolean) {
  const ref = useRef<ScrollViewInstance | null>(null);
  useEffect(() => {
    if (!keyboard) return;
    const t = setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [keyboard]);
  return ref;
}
