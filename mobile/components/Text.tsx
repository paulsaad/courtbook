import { Platform, StyleSheet, Text as RNText, useWindowDimensions, type StyleProp, type TextProps, type TextStyle } from "react-native";
import { color, font, MAX_FONT_SCALE } from "../lib/theme";

/**
 * The type scale. Readability floor from the approved design: body 16–17, secondary 15,
 * captions 13, nothing smaller except tab labels (12). Every variant follows the phone's text
 * size up to MAX_FONT_SCALE; layouts wrap rather than clip beyond that.
 */
export const variants = {
  title: { fontFamily: font.displayHeavy, fontSize: 30, lineHeight: 34, letterSpacing: -0.6, color: color.ink },
  heading: { fontFamily: font.display, fontSize: 20, lineHeight: 26, color: color.ink },
  body: { fontFamily: font.regular, fontSize: 16, lineHeight: 22, color: color.ink },
  strong: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: color.ink },
  secondary: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, color: color.muted },
  label: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: color.ink },
  caption: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: color.muted },
  eyebrow: { fontFamily: font.bold, fontSize: 14, lineHeight: 18, letterSpacing: 0.8, textTransform: "uppercase", color: color.muted },
  score: { fontFamily: font.score, fontSize: 32, lineHeight: 34, color: color.ink },
} satisfies Record<string, TextStyle>;

export type Variant = keyof typeof variants;

export function Text({ variant = "body", style, maxFontSizeMultiplier = MAX_FONT_SCALE, ...rest }: TextProps & { variant?: Variant }) {
  const capped = useCappedLineHeight([variants[variant], style], maxFontSizeMultiplier, rest.allowFontScaling);
  return <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[variants[variant], style, capped]} {...rest} />;
}

/**
 * React Native on Android scales `lineHeight` by the phone's full text size and ignores
 * `maxFontSizeMultiplier`, while the letters stop growing at the cap (TextAttributeProps.kt). At the
 * largest sizes that left wide gaps between lines (×2.0 phone setting, ×1.6 cap: lines 1.25× too far
 * apart). Past the cap, the line height given here is pre-shrunk so it lands where the cap puts the
 * letters. iOS already applies the cap to both, so nothing changes there.
 */
export function cappedLineHeight(lineHeight: number | undefined, fontScale: number, cap: number | undefined, os: string, allowFontScaling = true) {
  if (os !== "android" || !allowFontScaling || !lineHeight || !cap || cap < 1 || fontScale <= cap) return null;
  return { lineHeight: (lineHeight * cap) / fontScale };
}

export function useCappedLineHeight(style: StyleProp<TextStyle>, cap: number | undefined, allowFontScaling?: boolean) {
  const { fontScale } = useWindowDimensions();
  return cappedLineHeight(StyleSheet.flatten(style)?.lineHeight, fontScale, cap, Platform.OS, allowFontScaling);
}
