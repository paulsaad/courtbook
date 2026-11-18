import { Platform, Text, useWindowDimensions } from "react-native";
import { color, font } from "../lib/theme";

/**
 * Android only: a screen title that wraps to two lines instead of being cut ("Batroun Padel & T…",
 * F3). Android's header is a fixed 56 dp bar, so the title follows the phone's text size only up to
 * HEADER_MAX_FONT_SCALE: two lines then still fit the bar (2 × 21 × 1.2 ≈ 50 dp). A name longer than
 * two lines shrinks slightly rather than being cut. Screen readers read the full name.
 *
 * iOS keeps the standard title: its navigation bar does not grow with the text size.
 */
export const HEADER_MAX_FONT_SCALE = 1.2;
/** Room taken by the back button and the bar's own padding on Android. */
const HEADER_SIDE_ROOM = 104;

export function WrappingHeaderTitle({ children }: { children: string }) {
  const { width } = useWindowDimensions();
  return (
    <Text
      accessibilityRole="header"
      numberOfLines={2}
      adjustsFontSizeToFit
      minimumFontScale={0.85}
      maxFontSizeMultiplier={HEADER_MAX_FONT_SCALE}
      style={{ fontFamily: font.display, fontSize: 18, lineHeight: 21, color: color.ink, maxWidth: width - HEADER_SIDE_ROOM }}
    >
      {children}
    </Text>
  );
}

/** Screen options for a title that may be long. */
export function wrappingTitle(title: string) {
  return Platform.OS === "android"
    ? { title, headerTitle: () => <WrappingHeaderTitle>{title}</WrappingHeaderTitle> }
    : { title };
}
