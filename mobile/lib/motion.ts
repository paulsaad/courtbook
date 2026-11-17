import { AccessibilityInfo } from "react-native";

/**
 * The phone's "Reduce motion" setting. Read once at start and kept current; screens use it to jump
 * instead of scrolling smoothly and to show images without a fade.
 */
let reduce = false;
void AccessibilityInfo.isReduceMotionEnabled().then((v) => { reduce = v; }).catch(() => {});
AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => { reduce = v; });

export const reduceMotion = () => reduce;
/** For scrollTo({ animated }) */
export const animate = () => !reduce;
/** For expo-image's transition (ms) */
export const fade = (ms: number) => (reduce ? 0 : ms);
